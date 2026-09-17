import { invoke, isTauri as isTauriRuntime } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import packageJson from '../package.json';
import type {
  AppUpdateInfo,
  BridgeInfo,
  EditableItemInput,
  GeneratedPasswordOptions,
  ItemOverview,
  LoginInput,
  LoginItem,
  PasswordInput,
  PasswordItem,
  QuickAccessShortcut,
  TotpCode,
  VaultProfile,
  VaultItem,
  VaultStatus,
} from './types';

type Api = {
  getAppVersion(): Promise<string>;
  checkForUpdate(): Promise<AppUpdateInfo>;
  openExternalUrl(url: string): Promise<void>;
  getStatus(): Promise<VaultStatus>;
  getVaultProfile(): Promise<VaultProfile>;
  initializeVault(profileName: string, masterPassword: string): Promise<VaultStatus>;
  unlock(masterPassword: string): Promise<VaultStatus>;
  lock(): Promise<VaultStatus>;
  listItems(): Promise<ItemOverview[]>;
  getItem(id: string): Promise<VaultItem>;
  createLogin(input: LoginInput): Promise<LoginItem>;
  createPassword(input: PasswordInput): Promise<PasswordItem>;
  updateItem(id: string, input: EditableItemInput): Promise<VaultItem>;
  setFavorite(id: string, favorite: boolean): Promise<VaultItem>;
  getTotp(id: string): Promise<TotpCode | null>;
  generatePassword(options: GeneratedPasswordOptions): Promise<string>;
  copyText(value: string): Promise<void>;
  getQuickAccessShortcut(): Promise<QuickAccessShortcut>;
  setQuickAccessShortcut(shortcut: QuickAccessShortcut): Promise<QuickAccessShortcut>;
  getBridgeInfo(): Promise<BridgeInfo>;
  regenerateBridgeToken(): Promise<BridgeInfo>;
  listBridgeOrigins(): Promise<string[]>;
  revokeBridgeOrigin(origin: string): Promise<string[]>;
  respondBridgePairing(requestId: string, allow: boolean): Promise<void>;
  getExtensionDir(): Promise<string>;
};

const demoItems: VaultItem[] = [];
const browserVaultProfileStorageKey = 'captain.browserVaultProfile';

const fallbackVaultProfile: VaultProfile = { name: '本地保险库', avatar: '本' };
const appVersion = packageJson.version;
const githubLatestReleaseApiUrl = 'https://api.github.com/repos/heihuzicity-tech/CaptainPassword/releases/latest';
const githubLatestReleasePageUrl = 'https://github.com/heihuzicity-tech/CaptainPassword/releases/latest';

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  published_at?: string | null;
};

const normalizeVersion = (version: string) => version.trim().replace(/^v/i, '').split(/[+-]/)[0];

const versionSegments = (version: string) =>
  normalizeVersion(version)
    .split('.')
    .map((segment) => {
      const parsed = Number.parseInt(segment, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });

const compareVersions = (left: string, right: string) => {
  const leftSegments = versionSegments(left);
  const rightSegments = versionSegments(right);
  const segmentCount = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < segmentCount; index += 1) {
    const difference = (leftSegments[index] ?? 0) - (rightSegments[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
};

const assertOpenableUrl = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('只允许打开 HTTP/HTTPS 链接');
  }
  return parsed.toString();
};

const checkGitHubReleaseForUpdate = async (): Promise<AppUpdateInfo> => {
  const response = await fetch(githubLatestReleaseApiUrl, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`GitHub 返回 ${response.status}`);
  }

  const release = (await response.json()) as GitHubRelease;
  const tagName = release.tag_name?.trim();
  if (!tagName) throw new Error('GitHub release 缺少版本标签');

  const latestVersion = normalizeVersion(tagName);

  return {
    available: compareVersions(latestVersion, appVersion) > 0,
    currentVersion: appVersion,
    latestVersion,
    releaseName: release.name?.trim() || tagName,
    releaseUrl: release.html_url || githubLatestReleasePageUrl,
    notes: release.body?.trim() || '',
    publishedAt: release.published_at || '',
    checkedAt: new Date().toISOString(),
  };
};

const openUrlInBrowser = async (url: string) => {
  const safeUrl = assertOpenableUrl(url);
  if (isTauriRuntime()) {
    await openUrl(safeUrl);
    return;
  }

  window.open(safeUrl, '_blank', 'noopener,noreferrer');
};

const avatarForName = (name: string) => name.trim().slice(0, 1) || fallbackVaultProfile.avatar;

const readBrowserVaultProfile = () => {
  try {
    const saved = localStorage.getItem(browserVaultProfileStorageKey);
    if (!saved) return fallbackVaultProfile;
    const parsed = JSON.parse(saved) as Partial<VaultProfile>;
    if (!parsed.name?.trim()) return fallbackVaultProfile;
    const name = parsed.name.trim();
    return { name, avatar: parsed.avatar?.trim() || avatarForName(name) };
  } catch {
    return fallbackVaultProfile;
  }
};

const toOverview = (item: VaultItem): ItemOverview => ({
  id: item.id,
  item_type: item.item_type,
  title: item.title,
  subtitle: item.item_type === 'login' ? item.username : '密码',
  website: item.item_type === 'login' ? item.website : undefined,
  icon_text: item.title.slice(0, 2),
  favorite: item.favorite,
  updated_at: item.updated_at,
});

const primaryWebsite = (websites: string[], fallback: string) =>
  websites.find((website) => website.trim().length > 0) ?? websites[0] ?? fallback;

const totpPeriodSeconds = 30;

const normalizeTotpSecret = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('otpauth://')) {
    const rest = trimmed.slice('otpauth://'.length).replace(/^totp\//i, '');
    const query = rest.split('?')[1] ?? '';
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=');
      if (key === 'secret' && value.trim()) return value.trim().toUpperCase();
    }
    return '';
  }
  return trimmed.toUpperCase().replace(/[\s-]/g, '');
};

const base32Decode = (secret: string): Uint8Array => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = secret.toUpperCase().replace(/[\s-]/g, '');
  let bits = 0;
  let bitCount = 0;
  const output: number[] = [];
  for (const ch of normalized) {
    const value = alphabet.indexOf(ch);
    if (value === -1) throw new Error('invalid base32');
    bits = (bits << 5) | value;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      output.push((bits >>> bitCount) & 0xff);
    }
  }
  return new Uint8Array(output);
};

const computeTotpLocally = async (rawSecret: string): Promise<TotpCode> => {
  const secret = normalizeTotpSecret(rawSecret);
  if (!secret) throw new Error('empty secret');
  const counter = Math.floor(Date.now() / 1000 / totpPeriodSeconds);
  const counterBuffer = new ArrayBuffer(8);
  new DataView(counterBuffer).setUint32(4, counter);
  const key = await crypto.subtle.importKey('raw', base32Decode(secret) as BufferSource, {
    name: 'HMAC',
    hash: 'SHA-1',
  }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuffer));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return {
    code: String(binary % 1_000_000).padStart(6, '0'),
    remaining_seconds: totpPeriodSeconds - (Math.floor(Date.now() / 1000) % totpPeriodSeconds),
    period_seconds: totpPeriodSeconds,
  };
};

const randomPassword = (options: GeneratedPasswordOptions) => {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const numbers = '23456789';
  const symbols = '!@#$%^&*_-+=?';
  const alphabet = letters + (options.include_numbers ? numbers : '') + (options.include_symbols ? symbols : '');
  const bytes = new Uint32Array(options.length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
};

const quickAccessShortcutStorageKey = 'captain.quickAccessShortcut';
const defaultQuickAccessShortcut = (): QuickAccessShortcut =>
  navigator.platform.toLowerCase().includes('mac')
    ? { accelerator: 'Command+Alt+K', keys: ['⌥', '⌘', 'K'] }
    : { accelerator: 'Control+Alt+K', keys: ['Ctrl', 'Alt', 'K'] };

const readBrowserQuickAccessShortcut = () => {
  try {
    const saved = localStorage.getItem(quickAccessShortcutStorageKey);
    if (!saved) return defaultQuickAccessShortcut();
    const parsed = JSON.parse(saved) as Partial<QuickAccessShortcut>;
    if (!parsed.accelerator || !Array.isArray(parsed.keys) || parsed.keys.length < 2) {
      return defaultQuickAccessShortcut();
    }
    return { accelerator: parsed.accelerator, keys: parsed.keys };
  } catch {
    return defaultQuickAccessShortcut();
  }
};

const browserPreviewApi: Api = {
  async getAppVersion() {
    return appVersion;
  },
  checkForUpdate: checkGitHubReleaseForUpdate,
  openExternalUrl: openUrlInBrowser,
  async getStatus() {
    return localStorage.getItem(browserVaultProfileStorageKey) ? 'unlocked' : 'no_vault';
  },
  async getVaultProfile() {
    return readBrowserVaultProfile();
  },
  async initializeVault(profileName: string) {
    const name = profileName.trim() || fallbackVaultProfile.name;
    localStorage.setItem(browserVaultProfileStorageKey, JSON.stringify({ name, avatar: avatarForName(name) }));
    return 'unlocked';
  },
  async unlock() {
    return localStorage.getItem(browserVaultProfileStorageKey) ? 'unlocked' : 'no_vault';
  },
  async lock() {
    return 'locked';
  },
  async listItems() {
    return demoItems.map(toOverview);
  },
  async getItem(id: string) {
    const item = demoItems.find((entry) => entry.id === id);
    if (!item) throw new Error('Item not found');
    return item;
  },
  async createLogin(input: LoginInput) {
    const now = new Date().toISOString();
    const item: LoginItem = {
      id: crypto.randomUUID(),
      item_type: 'login',
      title: input.title || '未命名登录信息',
      username: input.username,
      password: input.password,
      website: input.website,
      websites: input.websites,
      website_labels: input.website_labels,
      totp_secret: normalizeTotpSecret(input.totp_secret),
      notes: input.notes,
      tags: input.tags,
      favorite: false,
      created_at: now,
      updated_at: now,
    };
    demoItems.unshift(item);
    return item;
  },
  async createPassword(input: PasswordInput) {
    const now = new Date().toISOString();
    const item: PasswordItem = {
      id: crypto.randomUUID(),
      item_type: 'password',
      title: input.title || '未命名密码',
      password: input.password,
      notes: input.notes,
      tags: input.tags,
      favorite: false,
      created_at: now,
      updated_at: now,
    };
    demoItems.unshift(item);
    return item;
  },
  async updateItem(id: string, update: EditableItemInput) {
    const index = demoItems.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error('Item not found');
    const current = demoItems[index];
    if (current.item_type !== update.item_type) throw new Error('Item type cannot be changed');

    const now = new Date().toISOString();
    const item: VaultItem =
      update.item_type === 'login'
        ? {
            id,
            item_type: 'login',
            title: update.input.title || '未命名登录信息',
            username: update.input.username,
            password: update.input.password,
            website: primaryWebsite(update.input.websites, update.input.website),
            websites: update.input.websites,
            website_labels: update.input.website_labels,
            totp_secret: normalizeTotpSecret(update.input.totp_secret),
            notes: update.input.notes,
            tags: update.input.tags,
            favorite: current.favorite,
            created_at: current.created_at,
            updated_at: now,
          }
        : {
            id,
            item_type: 'password',
            title: update.input.title || '未命名密码',
            password: update.input.password,
            notes: update.input.notes,
            tags: update.input.tags,
            favorite: current.favorite,
            created_at: current.created_at,
            updated_at: now,
          };
    demoItems[index] = item;
    return item;
  },
  async setFavorite(id: string, favorite: boolean) {
    const item = demoItems.find((entry) => entry.id === id);
    if (!item) throw new Error('Item not found');
    item.favorite = favorite;
    return item;
  },
  async getTotp(id: string) {
    const item = demoItems.find((entry) => entry.id === id);
    if (item?.item_type !== 'login' || !item.totp_secret.trim()) return null;
    try {
      return await computeTotpLocally(item.totp_secret);
    } catch {
      return null;
    }
  },
  async generatePassword(options: GeneratedPasswordOptions) {
    return randomPassword(options);
  },
  async copyText(value: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch {
        // Fall back below for browser previews that deny async clipboard writes.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy was rejected');
  },
  async getQuickAccessShortcut() {
    return readBrowserQuickAccessShortcut();
  },
  async setQuickAccessShortcut(shortcut: QuickAccessShortcut) {
    localStorage.setItem(quickAccessShortcutStorageKey, JSON.stringify(shortcut));
    return shortcut;
  },
  async getBridgeInfo() {
    return { port: 0, token: '' };
  },
  async regenerateBridgeToken() {
    return { port: 0, token: '' };
  },
  async listBridgeOrigins() {
    return [];
  },
  async revokeBridgeOrigin() {
    return [];
  },
  async respondBridgePairing() {},
  async getExtensionDir() {
    return '';
  },
};

const tauriApi: Api = {
  getAppVersion: async () => appVersion,
  checkForUpdate: checkGitHubReleaseForUpdate,
  openExternalUrl: openUrlInBrowser,
  getStatus: () => invoke<VaultStatus>('get_status'),
  getVaultProfile: () => invoke<VaultProfile>('get_vault_profile'),
  initializeVault: (profileName, masterPassword) => invoke<VaultStatus>('initialize_vault', { profileName, masterPassword }),
  unlock: (masterPassword) => invoke<VaultStatus>('unlock_vault', { masterPassword }),
  lock: () => invoke<VaultStatus>('lock_vault'),
  listItems: () => invoke<ItemOverview[]>('list_items'),
  getItem: (id) => invoke<VaultItem>('get_item', { id }),
  createLogin: (input) => invoke<LoginItem>('create_login', { input }),
  createPassword: (input) => invoke<PasswordItem>('create_password', { input }),
  updateItem: (id, input) => invoke<VaultItem>('update_item', { id, input }),
  setFavorite: (id, favorite) => invoke<VaultItem>('set_item_favorite', { id, favorite }),
  getTotp: (id) => invoke<TotpCode | null>('get_totp', { id }),
  generatePassword: (options) => invoke<string>('generate_password', { options }),
  copyText: (value) => invoke<void>('copy_text', { value }),
  getQuickAccessShortcut: () => invoke<QuickAccessShortcut>('get_quick_access_shortcut'),
  setQuickAccessShortcut: (shortcut) => invoke<QuickAccessShortcut>('set_quick_access_shortcut', { shortcut }),
  getBridgeInfo: () => invoke<BridgeInfo>('get_bridge_info'),
  regenerateBridgeToken: () => invoke<BridgeInfo>('regenerate_bridge_token'),
  listBridgeOrigins: () => invoke<string[]>('list_bridge_origins'),
  revokeBridgeOrigin: (origin) => invoke<string[]>('revoke_bridge_origin', { origin }),
  respondBridgePairing: (requestId, allow) => invoke<void>('respond_bridge_pairing', { requestId, allow }),
  getExtensionDir: () => invoke<string>('get_extension_dir'),
};

export const api: Api = isTauriRuntime() ? tauriApi : browserPreviewApi;
