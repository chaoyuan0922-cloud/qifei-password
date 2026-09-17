use std::{fs, path::PathBuf, sync::Mutex};

use std::{collections::HashMap, io::Read, sync::mpsc, time::Duration};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::rand_core::RngCore,
    aead::{Aead, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::{seq::SliceRandom, Rng};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
}

struct Session {
    root_key: [u8; 32],
}

impl Drop for Session {
    fn drop(&mut self) {
        self.root_key.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum VaultStatus {
    NoVault,
    Locked,
    Unlocked,
}

#[derive(Serialize, Deserialize)]
struct CipherBlob {
    v: u8,
    alg: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
struct KdfParams {
    alg: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

#[derive(Serialize, Deserialize)]
struct ItemOverview {
    id: String,
    item_type: String,
    title: String,
    subtitle: String,
    website: Option<String>,
    icon_text: String,
    #[serde(default)]
    favorite: bool,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct LoginDetails {
    id: String,
    item_type: String,
    title: String,
    username: String,
    password: String,
    website: String,
    #[serde(default)]
    websites: Vec<String>,
    #[serde(default)]
    website_labels: Vec<String>,
    #[serde(default)]
    totp_secret: String,
    notes: String,
    tags: Vec<String>,
    #[serde(default)]
    favorite: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct PasswordDetails {
    id: String,
    item_type: String,
    title: String,
    password: String,
    notes: String,
    tags: Vec<String>,
    #[serde(default)]
    favorite: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize)]
struct VaultProfile {
    name: String,
    avatar: String,
}

#[derive(Deserialize)]
struct LoginInput {
    title: String,
    username: String,
    password: String,
    website: String,
    #[serde(default)]
    websites: Vec<String>,
    #[serde(default)]
    website_labels: Vec<String>,
    #[serde(default)]
    totp_secret: String,
    notes: String,
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct PasswordInput {
    title: String,
    password: String,
    notes: String,
    tags: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "item_type", content = "input", rename_all = "snake_case")]
enum ItemUpdateInput {
    Login(LoginInput),
    Password(PasswordInput),
}

#[derive(Deserialize)]
struct GeneratedPasswordOptions {
    length: usize,
    include_numbers: bool,
    include_symbols: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct ShortcutPreference {
    accelerator: String,
    keys: Vec<String>,
}

const DEFAULT_VAULT_PROFILE_NAME: &str = "本地保险库";

fn data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| "Unable to resolve local data directory".to_string())?;
    Ok(base.join("CaptainPassword"))
}

fn db_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("captain-password.sqlite"))
}

fn preferences_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("preferences.json"))
}

fn default_quick_access_shortcut() -> ShortcutPreference {
    if cfg!(target_os = "macos") {
        ShortcutPreference {
            accelerator: "Command+Alt+K".to_string(),
            keys: vec!["⌥".to_string(), "⌘".to_string(), "K".to_string()],
        }
    } else {
        ShortcutPreference {
            accelerator: "Control+Alt+K".to_string(),
            keys: vec!["Ctrl".to_string(), "Alt".to_string(), "K".to_string()],
        }
    }
}

fn read_quick_access_shortcut() -> ShortcutPreference {
    let Ok(path) = preferences_path() else {
        return default_quick_access_shortcut();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return default_quick_access_shortcut();
    };
    serde_json::from_str::<ShortcutPreference>(&content)
        .unwrap_or_else(|_| default_quick_access_shortcut())
}

fn write_quick_access_shortcut(shortcut: &ShortcutPreference) -> Result<(), String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let content = serde_json::to_string_pretty(shortcut).map_err(|err| err.to_string())?;
    fs::write(preferences_path()?, content).map_err(|err| err.to_string())
}

fn show_quick_search<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("quick-search") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn register_quick_access_shortcut<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shortcut: &ShortcutPreference,
) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|err| err.to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut.accelerator.as_str(), |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                show_quick_search(app);
            }
        })
        .map_err(|err| err.to_string())
}

fn open_db() -> Result<Connection, String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let conn = Connection::open(db_path()?).map_err(|err| err.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| err.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS keysets (
          id TEXT PRIMARY KEY,
          kdf_json TEXT NOT NULL,
          salt BLOB NOT NULL,
          encrypted_root_key BLOB NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL,
          encrypted_overview BLOB NOT NULL,
          encrypted_details BLOB NOT NULL,
          favorite INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
        "#,
    )
    .map_err(|err| err.to_string())?;

    let has_favorite_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('items') WHERE name = 'favorite'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if has_favorite_column == 0 {
        conn.execute(
            "ALTER TABLE items ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|err| err.to_string())?;
    }

    Ok(())
}

fn has_vault(conn: &Connection) -> Result<bool, String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM keysets", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

fn derive_unlock_key(master_password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|err| err.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0_u8; 32];
    argon2
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|err| err.to_string())?;
    Ok(key)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0_u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn encrypt_bytes(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = random_bytes::<24>();
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|err| err.to_string())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|err| err.to_string())?;
    let blob = CipherBlob {
        v: 1,
        alg: "xchacha20poly1305".to_string(),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    };
    serde_json::to_vec(&blob).map_err(|err| err.to_string())
}

fn decrypt_bytes(key: &[u8; 32], aad: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    let blob: CipherBlob = serde_json::from_slice(encrypted).map_err(|err| err.to_string())?;
    if blob.v != 1 || blob.alg != "xchacha20poly1305" {
        return Err("Unsupported encrypted blob".to_string());
    }
    let nonce = BASE64.decode(blob.nonce).map_err(|err| err.to_string())?;
    let ciphertext = BASE64
        .decode(blob.ciphertext)
        .map_err(|err| err.to_string())?;
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|err| err.to_string())?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext.as_ref(),
                aad,
            },
        )
        .map_err(|_| "Decryption failed".to_string())
}

fn encrypt_json<T: Serialize>(key: &[u8; 32], aad: &[u8], value: &T) -> Result<Vec<u8>, String> {
    let plaintext = serde_json::to_vec(value).map_err(|err| err.to_string())?;
    encrypt_bytes(key, aad, &plaintext)
}

fn decrypt_json<T: for<'de> Deserialize<'de>>(
    key: &[u8; 32],
    aad: &[u8],
    encrypted: &[u8],
) -> Result<T, String> {
    let plaintext = decrypt_bytes(key, aad, encrypted)?;
    serde_json::from_slice(&plaintext).map_err(|err| err.to_string())
}

const TOTP_PERIOD_SECONDS: u64 = 30;

fn decode_base32(secret: &str) -> Result<Vec<u8>, String> {
    let mut bits: u32 = 0;
    let mut bit_count: u32 = 0;
    let mut output = Vec::with_capacity(secret.len() * 5 / 8);
    for ch in secret.chars() {
        if ch.is_whitespace() || ch == '-' || ch == '=' {
            continue;
        }
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32,
            '2'..='7' => ch as u32 - '2' as u32 + 26,
            _ => return Err("MFA 密钥包含无效的 Base32 字符。".to_string()),
        };
        bits = (bits << 5) | value;
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            output.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    if output.is_empty() {
        return Err("MFA 密钥不能为空。".to_string());
    }
    Ok(output)
}

fn normalize_base32_secret(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-')
        .flat_map(|ch| ch.to_uppercase())
        .collect()
}

/// Accepts either a raw Base32 secret or an `otpauth://totp/...` URI and
/// returns the normalized Base32 secret.
fn normalize_totp_secret(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if let Some(rest) = trimmed
        .strip_prefix("otpauth://")
        .map(|rest| rest.strip_prefix("totp/").unwrap_or(rest))
    {
        let query = rest.splitn(2, '?').nth(1).unwrap_or("");
        for pair in query.split('&') {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("secret") {
                let secret = parts.next().unwrap_or("").trim();
                if secret.is_empty() {
                    break;
                }
                decode_base32(secret)?;
                return Ok(normalize_base32_secret(secret));
            }
        }
        return Err("otpauth 链接中未找到 secret 参数。".to_string());
    }
    let normalized = normalize_base32_secret(trimmed);
    decode_base32(&normalized)?;
    Ok(normalized)
}

fn hotp_sha1(key: &[u8], counter: u64) -> String {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    format!("{:06}", binary % 1_000_000)
}

fn totp_code_at(secret: &str, unix_seconds: u64) -> Result<(String, u64), String> {
    let key = decode_base32(secret)?;
    let code = hotp_sha1(&key, unix_seconds / TOTP_PERIOD_SECONDS);
    let remaining = TOTP_PERIOD_SECONDS - (unix_seconds % TOTP_PERIOD_SECONDS);
    Ok((code, remaining))
}

fn unix_now_seconds() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|err| err.to_string())
}

fn current_root_key(state: &tauri::State<AppState>) -> Result<[u8; 32], String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?;
    guard
        .as_ref()
        .map(|session| session.root_key)
        .ok_or_else(|| "Vault is locked".to_string())
}

fn title_or_default(title: &str, fallback: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_profile_name(profile_name: &str) -> Result<String, String> {
    let trimmed = profile_name.trim();
    if trimmed.is_empty() {
        return Err("请输入用户名。".to_string());
    }
    if trimmed.chars().count() > 40 {
        return Err("用户名不能超过 40 个字符。".to_string());
    }
    Ok(trimmed.to_string())
}

fn profile_avatar(name: &str) -> String {
    name.chars()
        .next()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "本".to_string())
}

fn profile_from_name(name: String) -> VaultProfile {
    VaultProfile {
        avatar: profile_avatar(&name),
        name,
    }
}

fn icon_text(title: &str) -> String {
    title.chars().take(2).collect::<String>()
}

fn normalize_websites(primary: String, websites: Vec<String>) -> Vec<String> {
    let mut values = if websites.is_empty() {
        vec![primary]
    } else {
        websites
    };
    if values.is_empty() {
        values.push(String::new());
    }
    values
}

fn normalize_website_labels(mut labels: Vec<String>, len: usize) -> Vec<String> {
    labels.truncate(len);
    while labels.len() < len {
        labels.push("网站".to_string());
    }
    labels
}

fn primary_website(websites: &[String]) -> String {
    websites
        .iter()
        .find(|website| !website.trim().is_empty())
        .or_else(|| websites.first())
        .cloned()
        .unwrap_or_default()
}

fn details_value_with_favorite(
    root_key: &[u8; 32],
    id: &str,
    encrypted_details: &[u8],
    favorite: bool,
) -> Result<serde_json::Value, String> {
    let aad = format!("item-details:{id}");
    let mut details: serde_json::Value = decrypt_json(root_key, aad.as_bytes(), encrypted_details)?;
    if let Some(object) = details.as_object_mut() {
        // Items created before the MFA feature lack these fields; fill them in
        // so older vaults deserialize cleanly on the frontend.
        if !object.contains_key("totp_secret") {
            object.insert("totp_secret".to_string(), serde_json::Value::String(String::new()));
        }
        object.insert("favorite".to_string(), serde_json::Value::Bool(favorite));
    }
    Ok(details)
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Result<VaultStatus, String> {
    if state
        .session
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?
        .is_some()
    {
        return Ok(VaultStatus::Unlocked);
    }
    if !db_path()?.exists() {
        return Ok(VaultStatus::NoVault);
    }
    let conn = open_db()?;
    if has_vault(&conn)? {
        Ok(VaultStatus::Locked)
    } else {
        Ok(VaultStatus::NoVault)
    }
}

#[tauri::command]
fn get_vault_profile() -> Result<VaultProfile, String> {
    let conn = open_db()?;
    let name = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params!["vault_profile_name"],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| DEFAULT_VAULT_PROFILE_NAME.to_string());
    Ok(profile_from_name(name))
}

#[tauri::command]
fn initialize_vault(
    profile_name: String,
    master_password: String,
    state: tauri::State<AppState>,
) -> Result<VaultStatus, String> {
    let profile_name = normalize_profile_name(&profile_name)?;
    if master_password.len() < 8 {
        return Err("Master password must contain at least 8 characters".to_string());
    }

    let conn = open_db()?;
    if has_vault(&conn)? {
        return Err("A local vault already exists".to_string());
    }

    let salt = random_bytes::<16>();
    let mut unlock_key = derive_unlock_key(&master_password, &salt)?;
    let root_key = random_bytes::<32>();
    let encrypted_root_key = encrypt_bytes(&unlock_key, b"root-key", &root_key)?;
    unlock_key.zeroize();

    let now = Utc::now().to_rfc3339();
    let kdf = KdfParams {
        alg: "argon2id".to_string(),
        memory_kib: 19_456,
        iterations: 2,
        parallelism: 1,
    };

    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["schema_version", "1"],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params!["vault_profile_name", profile_name],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO keysets (id, kdf_json, salt, encrypted_root_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            serde_json::to_string(&kdf).map_err(|err| err.to_string())?,
            salt.as_slice(),
            encrypted_root_key,
            now,
            now
        ],
    )
    .map_err(|err| err.to_string())?;

    *state
        .session
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())? = Some(Session { root_key });
    Ok(VaultStatus::Unlocked)
}

#[tauri::command]
fn unlock_vault(
    master_password: String,
    state: tauri::State<AppState>,
) -> Result<VaultStatus, String> {
    let conn = open_db()?;
    let (salt, encrypted_root_key): (Vec<u8>, Vec<u8>) = conn
        .query_row(
            "SELECT salt, encrypted_root_key FROM keysets ORDER BY created_at LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "No local vault was found".to_string())?;
    let mut unlock_key = derive_unlock_key(&master_password, &salt)?;
    let root_key_bytes = decrypt_bytes(&unlock_key, b"root-key", &encrypted_root_key)?;
    unlock_key.zeroize();
    if root_key_bytes.len() != 32 {
        return Err("Root key is invalid".to_string());
    }
    let mut root_key = [0_u8; 32];
    root_key.copy_from_slice(&root_key_bytes);
    *state
        .session
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())? = Some(Session { root_key });
    Ok(VaultStatus::Unlocked)
}

#[tauri::command]
fn lock_vault(state: tauri::State<AppState>) -> Result<VaultStatus, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Session lock poisoned".to_string())?;
    if let Some(mut session) = guard.take() {
        session.root_key.zeroize();
    }
    Ok(VaultStatus::Locked)
}

#[tauri::command]
fn list_items(state: tauri::State<AppState>) -> Result<Vec<ItemOverview>, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let mut stmt = conn
        .prepare("SELECT id, encrypted_overview, favorite FROM items WHERE deleted_at IS NULL ORDER BY updated_at DESC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    let mut items = Vec::new();
    for row in rows {
        let (id, encrypted_overview, favorite) = row.map_err(|err| err.to_string())?;
        let aad = format!("item-overview:{id}");
        let mut overview: ItemOverview =
            decrypt_json(&root_key, aad.as_bytes(), &encrypted_overview)?;
        overview.favorite = favorite != 0;
        items.push(overview);
    }
    Ok(items)
}

#[tauri::command]
fn get_item(id: String, state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let (encrypted_details, favorite): (Vec<u8>, i64) = conn
        .query_row(
            "SELECT encrypted_details, favorite FROM items WHERE id = ?1 AND deleted_at IS NULL",
            params![id.clone()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Item not found".to_string())?;
    details_value_with_favorite(&root_key, &id, &encrypted_details, favorite != 0)
}

#[tauri::command]
fn create_login(input: LoginInput, state: tauri::State<AppState>) -> Result<LoginDetails, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let title = title_or_default(&input.title, "未命名登录信息");
    let icon_text = icon_text(&title);
    let websites = normalize_websites(input.website, input.websites);
    let website_labels = normalize_website_labels(input.website_labels, websites.len());
    let website = primary_website(&websites);
    let totp_secret = normalize_totp_secret(&input.totp_secret)?;
    let details = LoginDetails {
        id: id.clone(),
        item_type: "login".to_string(),
        title: title.clone(),
        username: input.username,
        password: input.password,
        website,
        websites,
        website_labels,
        totp_secret,
        notes: input.notes,
        tags: input.tags,
        favorite: false,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let overview = ItemOverview {
        id: id.clone(),
        item_type: "login".to_string(),
        title,
        subtitle: details.username.clone(),
        website: Some(details.website.clone()),
        icon_text,
        favorite: false,
        updated_at: now.clone(),
    };

    let overview_aad = format!("item-overview:{id}");
    let details_aad = format!("item-details:{id}");
    let encrypted_overview = encrypt_json(&root_key, overview_aad.as_bytes(), &overview)?;
    let encrypted_details = encrypt_json(&root_key, details_aad.as_bytes(), &details)?;

    conn.execute(
        "INSERT INTO items (id, item_type, encrypted_overview, encrypted_details, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, "login", encrypted_overview, encrypted_details, now, now],
    )
    .map_err(|err| err.to_string())?;

    Ok(details)
}

#[tauri::command]
fn create_password(
    input: PasswordInput,
    state: tauri::State<AppState>,
) -> Result<PasswordDetails, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let title = title_or_default(&input.title, "未命名密码");
    let icon_text = icon_text(&title);
    let details = PasswordDetails {
        id: id.clone(),
        item_type: "password".to_string(),
        title: title.clone(),
        password: input.password,
        notes: input.notes,
        tags: input.tags,
        favorite: false,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    let overview = ItemOverview {
        id: id.clone(),
        item_type: "password".to_string(),
        title,
        subtitle: "密码".to_string(),
        website: None,
        icon_text,
        favorite: false,
        updated_at: now.clone(),
    };

    let overview_aad = format!("item-overview:{id}");
    let details_aad = format!("item-details:{id}");
    let encrypted_overview = encrypt_json(&root_key, overview_aad.as_bytes(), &overview)?;
    let encrypted_details = encrypt_json(&root_key, details_aad.as_bytes(), &details)?;

    conn.execute(
        "INSERT INTO items (id, item_type, encrypted_overview, encrypted_details, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, "password", encrypted_overview, encrypted_details, now, now],
    )
    .map_err(|err| err.to_string())?;

    Ok(details)
}

#[tauri::command]
fn update_item(
    id: String,
    input: ItemUpdateInput,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let (existing_type, favorite, created_at): (String, i64, String) = conn
        .query_row(
            "SELECT item_type, favorite, created_at FROM items WHERE id = ?1 AND deleted_at IS NULL",
            params![id.clone()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "Item not found".to_string())?;

    let favorite_bool = favorite != 0;
    let now = Utc::now().to_rfc3339();

    match input {
        ItemUpdateInput::Login(input) => {
            if existing_type != "login" {
                return Err("Item type cannot be changed".to_string());
            }

            let title = title_or_default(&input.title, "未命名登录信息");
            let icon_text = icon_text(&title);
            let websites = normalize_websites(input.website, input.websites);
            let website_labels = normalize_website_labels(input.website_labels, websites.len());
            let website = primary_website(&websites);
            let totp_secret = normalize_totp_secret(&input.totp_secret)?;
            let details = LoginDetails {
                id: id.clone(),
                item_type: "login".to_string(),
                title: title.clone(),
                username: input.username,
                password: input.password,
                website,
                websites,
                website_labels,
                totp_secret,
                notes: input.notes,
                tags: input.tags,
                favorite: favorite_bool,
                created_at: created_at.clone(),
                updated_at: now.clone(),
            };
            let overview = ItemOverview {
                id: id.clone(),
                item_type: "login".to_string(),
                title,
                subtitle: details.username.clone(),
                website: Some(details.website.clone()),
                icon_text,
                favorite: favorite_bool,
                updated_at: now.clone(),
            };
            let overview_aad = format!("item-overview:{id}");
            let details_aad = format!("item-details:{id}");
            let encrypted_overview = encrypt_json(&root_key, overview_aad.as_bytes(), &overview)?;
            let encrypted_details = encrypt_json(&root_key, details_aad.as_bytes(), &details)?;

            conn.execute(
                "UPDATE items SET encrypted_overview = ?1, encrypted_details = ?2, updated_at = ?3, version = version + 1 WHERE id = ?4 AND deleted_at IS NULL",
                params![encrypted_overview, encrypted_details, now, id],
            )
            .map_err(|err| err.to_string())?;

            serde_json::to_value(details).map_err(|err| err.to_string())
        }
        ItemUpdateInput::Password(input) => {
            if existing_type != "password" {
                return Err("Item type cannot be changed".to_string());
            }

            let title = title_or_default(&input.title, "未命名密码");
            let icon_text = icon_text(&title);
            let details = PasswordDetails {
                id: id.clone(),
                item_type: "password".to_string(),
                title: title.clone(),
                password: input.password,
                notes: input.notes,
                tags: input.tags,
                favorite: favorite_bool,
                created_at,
                updated_at: now.clone(),
            };
            let overview = ItemOverview {
                id: id.clone(),
                item_type: "password".to_string(),
                title,
                subtitle: "密码".to_string(),
                website: None,
                icon_text,
                favorite: favorite_bool,
                updated_at: now.clone(),
            };
            let overview_aad = format!("item-overview:{id}");
            let details_aad = format!("item-details:{id}");
            let encrypted_overview = encrypt_json(&root_key, overview_aad.as_bytes(), &overview)?;
            let encrypted_details = encrypt_json(&root_key, details_aad.as_bytes(), &details)?;

            conn.execute(
                "UPDATE items SET encrypted_overview = ?1, encrypted_details = ?2, updated_at = ?3, version = version + 1 WHERE id = ?4 AND deleted_at IS NULL",
                params![encrypted_overview, encrypted_details, now, id],
            )
            .map_err(|err| err.to_string())?;

            serde_json::to_value(details).map_err(|err| err.to_string())
        }
    }
}

#[tauri::command]
fn set_item_favorite(
    id: String,
    favorite: bool,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let changed = conn
        .execute(
            "UPDATE items SET favorite = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![if favorite { 1 } else { 0 }, id.clone()],
        )
        .map_err(|err| err.to_string())?;
    if changed == 0 {
        return Err("Item not found".to_string());
    }

    let encrypted_details: Vec<u8> = conn
        .query_row(
            "SELECT encrypted_details FROM items WHERE id = ?1",
            params![id.clone()],
            |row| row.get(0),
        )
        .map_err(|_| "Item not found".to_string())?;
    details_value_with_favorite(&root_key, &id, &encrypted_details, favorite)
}

#[tauri::command]
fn generate_password(options: GeneratedPasswordOptions) -> Result<String, String> {
    let length = options.length.clamp(8, 64);
    let letters = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let numbers = b"23456789";
    let symbols = b"!@#$%^&*_-+=?";
    let mut alphabet = letters.to_vec();
    if options.include_numbers {
        alphabet.extend_from_slice(numbers);
    }
    if options.include_symbols {
        alphabet.extend_from_slice(symbols);
    }

    let mut rng = rand::thread_rng();
    let mut password = Vec::with_capacity(length);
    if options.include_numbers {
        password.push(
            *numbers
                .choose(&mut rng)
                .ok_or_else(|| "Failed to generate password".to_string())?,
        );
    }
    if options.include_symbols {
        password.push(
            *symbols
                .choose(&mut rng)
                .ok_or_else(|| "Failed to generate password".to_string())?,
        );
    }
    while password.len() < length {
        let index = rng.gen_range(0..alphabet.len());
        password.push(alphabet[index]);
    }
    password.shuffle(&mut rng);
    String::from_utf8(password).map_err(|err| err.to_string())
}

#[tauri::command]
fn copy_text(value: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|err| err.to_string())?;
    clipboard.set_text(value).map_err(|err| err.to_string())
}

#[derive(Serialize)]
struct TotpCode {
    code: String,
    remaining_seconds: u64,
    period_seconds: u64,
}

#[tauri::command]
fn get_totp(id: String, state: tauri::State<AppState>) -> Result<Option<TotpCode>, String> {
    let root_key = current_root_key(&state)?;
    let conn = open_db()?;
    let (item_type, encrypted_details): (String, Vec<u8>) = conn
        .query_row(
            "SELECT item_type, encrypted_details FROM items WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Item not found".to_string())?;
    if item_type != "login" {
        return Ok(None);
    }
    let aad = format!("item-details:{id}");
    let details: LoginDetails = decrypt_json(&root_key, aad.as_bytes(), &encrypted_details)?;
    if details.totp_secret.trim().is_empty() {
        return Ok(None);
    }
    let (code, remaining_seconds) = totp_code_at(&details.totp_secret, unix_now_seconds()?)?;
    Ok(Some(TotpCode {
        code,
        remaining_seconds,
        period_seconds: TOTP_PERIOD_SECONDS,
    }))
}

#[tauri::command]
fn get_quick_access_shortcut() -> ShortcutPreference {
    read_quick_access_shortcut()
}

#[tauri::command]
fn set_quick_access_shortcut<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    shortcut: ShortcutPreference,
) -> Result<ShortcutPreference, String> {
    let previous_shortcut = read_quick_access_shortcut();
    if let Err(err) = register_quick_access_shortcut(&app, &shortcut) {
        let _ = register_quick_access_shortcut(&app, &previous_shortcut);
        return Err(err);
    }
    write_quick_access_shortcut(&shortcut)?;
    Ok(shortcut)
}

// ===== Browser extension bridge =====

const BRIDGE_HOST: &str = "127.0.0.1";
const BRIDGE_PORT_RANGE: std::ops::RangeInclusive<u16> = 27124..=27163;
const BRIDGE_MAX_BODY_BYTES: u64 = 64 * 1024;
const BRIDGE_PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const BRIDGE_ALLOWED_ORIGINS_KEY: &str = "bridge_allowed_origins";
const BRIDGE_PAIRING_EVENT: &str = "bridge-pairing-request";

#[derive(Serialize, Deserialize, Clone)]
struct BridgeInfo {
    port: u16,
    token: String,
}

struct BridgeShared {
    info: Mutex<Option<BridgeInfo>>,
    token: Mutex<String>,
}

struct PairingEntry {
    request_id: String,
    senders: Vec<mpsc::SyncSender<bool>>,
}

#[derive(Default)]
struct BridgePairing {
    pending: Mutex<HashMap<String, PairingEntry>>,
}

fn bridge_file_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("bridge.json"))
}

fn random_bridge_token() -> String {
    let bytes: [u8; 16] = random_bytes();
    BASE64.encode(bytes)
}

fn persist_bridge_info(info: &BridgeInfo) -> Result<(), String> {
    let dir = data_dir()?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let content = serde_json::to_string_pretty(info).map_err(|err| err.to_string())?;
    fs::write(bridge_file_path()?, content).map_err(|err| err.to_string())
}

fn read_allowed_bridge_origins(conn: &Connection) -> Result<Vec<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![BRIDGE_ALLOWED_ORIGINS_KEY],
            |row| row.get(0),
        )
        .unwrap_or(None);
    let origins = raw
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .unwrap_or_default();
    Ok(origins)
}

fn add_allowed_bridge_origin(conn: &Connection, host: &str) -> Result<(), String> {
    let mut origins = read_allowed_bridge_origins(conn)?;
    if !origins.iter().any(|origin| origin == host) {
        origins.push(host.to_string());
        let value = serde_json::to_string(&origins).map_err(|err| err.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![BRIDGE_ALLOWED_ORIGINS_KEY, value],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Extracts a lowercase hostname from a URL, an `host:port` pair or a bare host.
fn normalize_bridge_host(raw: &str) -> Option<String> {
    let trimmed = raw.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed.split("://").nth(1).unwrap_or(&trimmed);
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

fn strip_www_suffix(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// Matches two hosts, allowing subdomain matches so a site entry of
/// `example.com` also fills on `login.example.com`.
fn bridge_hosts_match(entry: &str, page: &str) -> bool {
    let entry = strip_www_suffix(entry);
    let page = strip_www_suffix(page);
    entry == page || page.ends_with(&format!(".{entry}")) || entry.ends_with(&format!(".{page}"))
}

#[derive(Serialize)]
struct BridgeLoginItem {
    id: String,
    title: String,
    username: String,
    password: String,
    totp_code: Option<String>,
    totp_remaining_seconds: Option<u64>,
}

fn collect_bridge_logins(
    root_key: &[u8; 32],
    page_host: &str,
) -> Result<Vec<BridgeLoginItem>, String> {
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, encrypted_details FROM items WHERE item_type = 'login' AND deleted_at IS NULL",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|err| err.to_string())?;

    let now = unix_now_seconds()?;
    let mut items = Vec::new();
    for row in rows {
        let (id, encrypted_details) = row.map_err(|err| err.to_string())?;
        let aad = format!("item-details:{id}");
        let Ok(details) = decrypt_json::<LoginDetails>(root_key, aad.as_bytes(), &encrypted_details)
        else {
            continue;
        };
        let matches = {
            let mut websites = details.websites.clone();
            if websites.is_empty() && !details.website.trim().is_empty() {
                websites.push(details.website.clone());
            }
            websites
                .iter()
                .filter_map(|website| normalize_bridge_host(website))
                .any(|host| bridge_hosts_match(&host, page_host))
        };
        if !matches {
            continue;
        }
        let totp = if details.totp_secret.trim().is_empty() {
            None
        } else {
            totp_code_at(&details.totp_secret, now).ok()
        };
        items.push(BridgeLoginItem {
            id,
            title: details.title,
            username: details.username,
            password: details.password,
            totp_code: totp.as_ref().map(|entry| entry.0.clone()),
            totp_remaining_seconds: totp.map(|entry| entry.1),
        });
    }
    Ok(items)
}

fn bridge_json_response(request: tiny_http::Request, status_code: u16, body: &serde_json::Value) {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let response = tiny_http::Response::from_data(payload)
        .with_status_code(status_code)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap(),
        )
        .with_header(
            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        );
    let _ = request.respond(response);
}

fn bridge_method_not_allowed(request: tiny_http::Request) {
    bridge_json_response(
        request,
        405,
        &serde_json::json!({ "status": "method_not_allowed" }),
    );
}

fn bridge_unauthorized(request: tiny_http::Request) {
    bridge_json_response(request, 401, &serde_json::json!({ "status": "unauthorized" }));
}

fn bridge_wait_for_pairing<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    page_host: &str,
) -> Result<bool, String> {
    let pairing = app.state::<BridgePairing>();
    let (sender, receiver) = mpsc::sync_channel::<bool>(1);
    let request_id = Uuid::new_v4().to_string();
    let mut announce = false;

    {
        let mut pending = pairing
            .pending
            .lock()
            .map_err(|_| "Pairing lock poisoned".to_string())?;
        let entry = pending
            .entry(page_host.to_string())
            .or_insert_with(|| {
                announce = true;
                PairingEntry {
                    request_id: request_id.clone(),
                    senders: Vec::new(),
                }
            });
        entry.senders.push(sender);
    }

    if announce {
        app.emit(
            BRIDGE_PAIRING_EVENT,
            serde_json::json!({ "request_id": request_id, "origin": page_host }),
        )
        .map_err(|err| err.to_string())?;
    }

    let decision = match receiver.recv_timeout(BRIDGE_PAIRING_TIMEOUT) {
        Ok(decision) => decision,
        Err(_) => {
            // Timed out. As the request that opened the dialog, drop the
            // pending entry so later requests can start a fresh pairing.
            if announce {
                if let Ok(mut pending) = pairing.pending.lock() {
                    if pending
                        .get(page_host)
                        .is_some_and(|entry| entry.request_id == request_id)
                    {
                        pending.remove(page_host);
                    }
                }
            }
            false
        }
    };
    Ok(decision)
}

fn handle_bridge_logins<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: tiny_http::Request,
    body: &[u8],
) {
    #[derive(Deserialize)]
    struct LoginsInput {
        origin: String,
    }

    let input: LoginsInput = match serde_json::from_slice(body) {
        Ok(input) => input,
        Err(_) => {
            bridge_json_response(request, 400, &serde_json::json!({ "status": "bad_request" }));
            return;
        }
    };
    let Some(page_host) = normalize_bridge_host(&input.origin) else {
        bridge_json_response(request, 400, &serde_json::json!({ "status": "bad_request" }));
        return;
    };

    let state = app.state::<AppState>();
    let root_key = match current_root_key(&state) {
        Ok(root_key) => root_key,
        Err(_) => {
            bridge_json_response(request, 200, &serde_json::json!({ "status": "locked", "items": [] }));
            return;
        }
    };

    let conn = match open_db() {
        Ok(conn) => conn,
        Err(err) => {
            bridge_json_response(request, 500, &serde_json::json!({ "status": "error", "message": err }));
            return;
        }
    };
    let allowed = match read_allowed_bridge_origins(&conn) {
        Ok(allowed) => allowed,
        Err(err) => {
            bridge_json_response(request, 500, &serde_json::json!({ "status": "error", "message": err }));
            return;
        }
    };

    if !allowed
        .iter()
        .any(|entry| bridge_hosts_match(entry, &page_host))
    {
        let decision = bridge_wait_for_pairing(app, &page_host).unwrap_or(false);
        if !decision {
            bridge_json_response(request, 200, &serde_json::json!({ "status": "denied" }));
            return;
        }
        if let Err(err) = add_allowed_bridge_origin(&conn, &page_host) {
            bridge_json_response(request, 500, &serde_json::json!({ "status": "error", "message": err }));
            return;
        }
    }

    match collect_bridge_logins(&root_key, &page_host) {
        Ok(items) => bridge_json_response(
            request,
            200,
            &serde_json::json!({ "status": "ok", "items": items }),
        ),
        Err(err) => bridge_json_response(request, 500, &serde_json::json!({ "status": "error", "message": err })),
    }
}

fn handle_bridge_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &BridgeShared,
    mut request: tiny_http::Request,
) {
    if *request.method() == tiny_http::Method::Options {
        let response = tiny_http::Response::empty(204)
            .with_header(
                tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET, POST, OPTIONS"[..])
                    .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Access-Control-Allow-Headers"[..],
                    &b"Authorization, Content-Type"[..],
                )
                .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(&b"Access-Control-Max-Age"[..], &b"86400"[..]).unwrap(),
            );
        let _ = request.respond(response);
        return;
    }

    let expected_token = shared
        .token
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let authorized = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer "))
        .is_some_and(|token| token == expected_token);
    if !authorized || expected_token.is_empty() {
        bridge_unauthorized(request);
        return;
    }

    let path = request.url().split('?').next().unwrap_or("").to_string();
    match (request.method().as_str(), path.as_str()) {
        ("GET", "/status") => {
            let status = {
                let state = app.state::<AppState>();
                let guard = state.session.lock().ok();
                match guard {
                    Some(guard) if guard.is_some() => "unlocked",
                    _ => {
                        if db_path().map(|path| path.exists()).unwrap_or(false) {
                            "locked"
                        } else {
                            "no_vault"
                        }
                    }
                }
            };
            bridge_json_response(
                request,
                200,
                &serde_json::json!({ "status": status, "version": env!("CARGO_PKG_VERSION") }),
            );
        }
        ("POST", "/logins") => {
            let mut body = Vec::new();
            if request
                .as_reader()
                .take(BRIDGE_MAX_BODY_BYTES)
                .read_to_end(&mut body)
                .is_err()
            {
                bridge_json_response(request, 400, &serde_json::json!({ "status": "bad_request" }));
                return;
            }
            handle_bridge_logins(app, request, &body);
        }
        _ => bridge_method_not_allowed(request),
    }
}

fn start_bridge_server<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    // Managed unconditionally and as the plain value type (not Arc) so the
    // `tauri::State<BridgeShared>` command parameters can find it even when
    // no port could be bound.
    app.manage(BridgeShared {
        info: Mutex::new(None),
        token: Mutex::new(random_bridge_token()),
    });
    app.manage(BridgePairing::default());

    let mut bound = None;
    let mut last_bind_error = String::new();
    for port in BRIDGE_PORT_RANGE {
        match tiny_http::Server::http((BRIDGE_HOST, port)) {
            Ok(server) => {
                bound = Some((server, port));
                break;
            }
            Err(err) => last_bind_error = err.to_string(),
        }
    }
    let Some((server, port)) = bound else {
        eprintln!(
            "Failed to start browser bridge: no port available in {}-{}: {last_bind_error}",
            BRIDGE_PORT_RANGE.start(),
            BRIDGE_PORT_RANGE.end()
        );
        return;
    };

    let info = BridgeInfo {
        port,
        token: app
            .state::<BridgeShared>()
            .token
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default(),
    };
    if let Err(err) = persist_bridge_info(&info) {
        eprintln!("Failed to persist bridge info: {err}");
    }
    if let Ok(mut guard) = app.state::<BridgeShared>().info.lock() {
        *guard = Some(info);
    }

    let server = std::sync::Arc::new(server);
    for worker in 0..3 {
        let server = server.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            match server.recv() {
                Ok(request) => {
                    let shared = app.state::<BridgeShared>();
                    handle_bridge_request(&app, &shared, request);
                }
                Err(err) => {
                    eprintln!("Bridge worker {worker} stopped: {err}");
                    break;
                }
            }
        });
    }
}

#[tauri::command]
fn get_bridge_info(state: tauri::State<BridgeShared>) -> Result<BridgeInfo, String> {
    let info = state
        .info
        .lock()
        .map_err(|_| "Bridge lock poisoned".to_string())?
        .clone();
    info.ok_or_else(|| "浏览器桥接未启动".to_string())
}

#[tauri::command]
fn regenerate_bridge_token(state: tauri::State<BridgeShared>) -> Result<BridgeInfo, String> {
    let token = random_bridge_token();
    let info = {
        let port = state
            .info
            .lock()
            .map_err(|_| "Bridge lock poisoned".to_string())?
            .as_ref()
            .map(|info| info.port)
            .ok_or_else(|| "浏览器桥接未启动".to_string())?;
        let mut token_guard = state
            .token
            .lock()
            .map_err(|_| "Bridge lock poisoned".to_string())?;
        *token_guard = token.clone();
        BridgeInfo { port, token }
    };
    persist_bridge_info(&info)?;
    Ok(info)
}

#[tauri::command]
fn list_bridge_origins() -> Result<Vec<String>, String> {
    let conn = open_db()?;
    read_allowed_bridge_origins(&conn)
}

#[tauri::command]
fn revoke_bridge_origin(origin: String) -> Result<Vec<String>, String> {
    let conn = open_db()?;
    let remaining: Vec<String> = read_allowed_bridge_origins(&conn)?
        .into_iter()
        .filter(|entry| entry != &origin)
        .collect();
    let value = serde_json::to_string(&remaining).map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![BRIDGE_ALLOWED_ORIGINS_KEY, value],
    )
    .map_err(|err| err.to_string())?;
    Ok(remaining)
}

#[tauri::command]
fn respond_bridge_pairing(
    request_id: String,
    allow: bool,
    pairing: tauri::State<BridgePairing>,
) -> Result<(), String> {
    let mut pending = pairing
        .pending
        .lock()
        .map_err(|_| "Pairing lock poisoned".to_string())?;
    let mut found = false;
    pending.retain(|_, entry| {
        if entry.request_id == request_id {
            found = true;
            for sender in entry.senders.drain(..) {
                let _ = sender.send(allow);
            }
            false
        } else {
            true
        }
    });
    if !found {
        return Err("没有等待中的配对请求".to_string());
    }
    Ok(())
}

fn display_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().to_string();
    // Strip the Windows verbatim prefix so file pickers and browsers accept it.
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[tauri::command]
fn get_extension_dir<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    if cfg!(debug_assertions) {
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extension");
        if dev_dir.is_dir() {
            let canonical = dev_dir.canonicalize().map_err(|err| err.to_string())?;
            return Ok(display_path(&canonical));
        }
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| "Unable to resolve resource directory".to_string())?
        .join("extension");
    if resource_dir.is_dir() {
        return Ok(display_path(&resource_dir));
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
        .ok_or_else(|| "Unable to resolve executable directory".to_string())?
        .join("extension");
    if exe_dir.is_dir() {
        return Ok(display_path(&exe_dir));
    }
    Err("未找到浏览器扩展文件，请重新安装应用。".to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            app.handle()
                .plugin(tauri_plugin_global_shortcut::Builder::new().build())
                .map_err(|err| Box::<dyn std::error::Error>::from(err.to_string()))?;
            let shortcut = read_quick_access_shortcut();
            if let Err(err) = register_quick_access_shortcut(app.handle(), &shortcut) {
                eprintln!("Failed to register quick access shortcut: {err}");
            }
            start_bridge_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_vault_profile,
            initialize_vault,
            unlock_vault,
            lock_vault,
            list_items,
            get_item,
            create_login,
            create_password,
            update_item,
            set_item_favorite,
            generate_password,
            copy_text,
            get_totp,
            get_quick_access_shortcut,
            set_quick_access_shortcut,
            get_bridge_info,
            regenerate_bridge_token,
            list_bridge_origins,
            revoke_bridge_origin,
            respond_bridge_pairing,
            get_extension_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running FlyPassword");
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn totp_matches_rfc6238_vectors() {
        // RFC 6238 SHA-1 vectors, truncated to 6 digits.
        let cases = [
            (59_u64, "287082"),
            (1_111_111_109, "081804"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ];
        for (time, expected) in cases {
            let (code, remaining) = totp_code_at(RFC_SECRET, time).expect("totp succeeds");
            assert_eq!(code, expected, "time={time}");
            assert_eq!(remaining, 30 - (time % 30));
        }
    }

    #[test]
    fn base32_decode_handles_spacing_and_case() {
        let decoded = decode_base32("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").expect("decodes");
        assert_eq!(decoded, b"12345678901234567890");
    }

    #[test]
    fn base32_decode_rejects_invalid_characters() {
        assert!(decode_base32("ABC@1!").is_err());
        assert!(decode_base32("").is_err());
    }

    #[test]
    fn totp_secret_normalization_accepts_otpauth_uri() {
        let secret = normalize_totp_secret(
            "otpauth://totp/GitHub:user@example.com?secret=gezdgnbvgy3tqojqgezdgnbvgy3tqojq&issuer=GitHub",
        )
        .expect("parses otpauth uri");
        assert_eq!(secret, RFC_SECRET);
    }

    #[test]
    fn totp_secret_normalization_accepts_raw_secret() {
        let secret = normalize_totp_secret("gezd gnbv-gy3t qojq").expect("normalizes raw secret");
        assert_eq!(secret, "GEZDGNBVGY3TQOJQ");
        assert!(normalize_totp_secret("not base32 !!").is_err());
        assert!(normalize_totp_secret("otpauth://totp/x?issuer=only").is_err());
        assert_eq!(normalize_totp_secret("").unwrap(), "");
        assert_eq!(normalize_totp_secret("  ").unwrap(), "");
    }

    #[test]
    fn bridge_host_normalization_covers_urls_and_bare_hosts() {
        assert_eq!(
            normalize_bridge_host("https://github.com/login").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            normalize_bridge_host("HTTPS://Login.GitHub.com:443/").as_deref(),
            Some("login.github.com")
        );
        assert_eq!(
            normalize_bridge_host("http://user:pass@example.com:8080/x").as_deref(),
            Some("example.com")
        );
        assert_eq!(normalize_bridge_host("example.com").as_deref(), Some("example.com"));
        assert_eq!(normalize_bridge_host("example.com.").as_deref(), Some("example.com"));
        assert_eq!(normalize_bridge_host("http://[::1]:3000/").as_deref(), Some("::1"));
        assert_eq!(normalize_bridge_host("   "), None);
        assert_eq!(normalize_bridge_host(""), None);
    }

    #[test]
    fn bridge_hosts_match_allows_subdomains_and_www() {
        assert!(bridge_hosts_match("github.com", "github.com"));
        assert!(bridge_hosts_match("github.com", "gist.github.com"));
        assert!(bridge_hosts_match("www.example.com", "example.com"));
        assert!(bridge_hosts_match("example.com", "www.example.com"));
        assert!(!bridge_hosts_match("github.com", "notgithub.com"));
        assert!(!bridge_hosts_match("mail.github.com.evil.io", "github.com"));
        assert!(!bridge_hosts_match("example.org", "example.com"));
    }

    #[test]
    fn details_value_backfills_missing_totp_secret_for_legacy_items() {
        let root_key: [u8; 32] = std::array::from_fn(|index| (index % 251) as u8);
        let legacy: serde_json::Value = serde_json::json!({
            "id": "legacy-1",
            "item_type": "login",
            "title": "Old entry",
            "username": "user",
            "password": "pass",
            "website": "https://example.com",
            "notes": "",
            "tags": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        });
        let encrypted =
            encrypt_json(&root_key, b"item-details:legacy-1", &legacy).expect("encrypts");
        let value = details_value_with_favorite(&root_key, "legacy-1", &encrypted, true)
            .expect("decrypts");
        assert_eq!(value["totp_secret"], "");
        assert_eq!(value["favorite"], true);
        assert_eq!(value["username"], "user");
    }
}
