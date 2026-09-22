import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  Banknote,
  BookUser,
  Braces,
  CarFront,
  Check,
  ChevronDown,
  Command,
  CreditCard,
  Database,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  Gift,
  Grid2X2,
  HeartPulse,
  GripVertical,
  IdCard,
  KeyRound,
  Landmark,
  ListFilter,
  Lock,
  LockKeyhole,
  LogOut,
  Mail,
  MinusCircle,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  QrCode,
  RefreshCw,
  Search,
  Server,
  Settings,
  Share,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  Trees,
  WalletCards,
  Wifi,
  X,
} from 'lucide-react';
import { useCallback, Component, useEffect, useId, useMemo, useRef, useState, type ErrorInfo } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openPath } from '@tauri-apps/plugin-opener';
import jsQR from 'jsqr';
import { api } from './api';
import type {
  AppUpdateInfo,
  BridgeInfo,
  EditableItemInput,
  ItemOverview,
  ItemType,
  LoginInput,
  PasswordInput,
  QuickAccessShortcut,
  TotpCode,
  VaultProfile,
  VaultItem,
  VaultStatus,
} from './types';
import { startWindowDrag } from './windowDrag';

type Overlay =
  | { kind: 'none' }
  | { kind: 'type-picker' }
  | { kind: 'editor'; itemType: ItemType }
  | { kind: 'settings' };
type BridgePairingRequest = {
  origin: string;
};
type SidebarView = 'all' | 'favorites';
type CategoryFilter = 'all' | ItemType;
type ResizablePane = 'sidebar' | 'itemList';
type FieldBorderStyle = 'top' | 'middle' | 'bottom' | 'single';
type FieldTone = 'primary' | 'secondary';
type PasswordGeneratorType = 'random' | 'memorable' | 'pin';
type AppWindowMode = 'main' | 'quick-search';
type QuickCopyField = {
  id: string;
  label: string;
  value: string;
  secret?: boolean;
  primary?: boolean;
};
type ShortcutConfig = QuickAccessShortcut;
type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey' | 'stopPropagation'
>;

const APP_NAME = '起飞密码箱';
const QUICK_WINDOW_LABEL = 'quick-search';
const LOCAL_VAULT_NAME = '本地保险库';
const LOCAL_VAULT_AVATAR = '本';
const DEFAULT_VAULT_PROFILE: VaultProfile = { name: LOCAL_VAULT_NAME, avatar: LOCAL_VAULT_AVATAR };
const quickWindowWidth = 380;
const sidebarWidthLimits = { min: 230, max: 420, default: 276 };
const itemListWidthLimits = { min: 300, max: 520, default: 354 };
const passwordLengthLimits = { min: 8, max: 40, default: 8 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isMacPlatform = () => navigator.platform.toLowerCase().includes('mac');
const defaultQuickAccessShortcut = (): ShortcutConfig =>
  isMacPlatform()
    ? { accelerator: 'Command+Alt+K', keys: ['⌥', '⌘', 'K'] }
    : { accelerator: 'Control+Alt+K', keys: ['Ctrl', 'Alt', 'K'] };
const keyboardShortcutKey = (key: string) => {
  if (key === ' ' || key === 'Spacebar') return { accelerator: 'Space', display: 'Space' };
  if (key.length === 1) return { accelerator: key.toUpperCase(), display: key.toUpperCase() };
  const keyMap: Record<string, { accelerator: string; display: string }> = {
    ArrowDown: { accelerator: 'ArrowDown', display: '↓' },
    ArrowLeft: { accelerator: 'ArrowLeft', display: '←' },
    ArrowRight: { accelerator: 'ArrowRight', display: '→' },
    ArrowUp: { accelerator: 'ArrowUp', display: '↑' },
    Backspace: { accelerator: 'Backspace', display: 'Backspace' },
    Delete: { accelerator: 'Delete', display: 'Delete' },
    Enter: { accelerator: 'Enter', display: 'Enter' },
    Escape: { accelerator: 'Escape', display: 'Esc' },
    Tab: { accelerator: 'Tab', display: 'Tab' },
  };
  return keyMap[key] ?? { accelerator: key, display: key };
};
const shortcutFromKeyboardEvent = (event: ShortcutKeyEvent): { shortcut?: ShortcutConfig; error?: string } => {
  const modifierOnly = ['Alt', 'Control', 'Meta', 'Shift'].includes(event.key);
  if (modifierOnly) return { error: '请同时按下修饰键和一个普通键。' };

  const mac = isMacPlatform();
  const modifiers = [
    { active: event.ctrlKey, accelerator: 'Control', display: mac ? '⌃' : 'Ctrl' },
    { active: event.altKey, accelerator: 'Alt', display: mac ? '⌥' : 'Alt' },
    { active: event.shiftKey, accelerator: 'Shift', display: mac ? '⇧' : 'Shift' },
    { active: event.metaKey, accelerator: 'Command', display: mac ? '⌘' : 'Win' },
  ].filter((modifier) => modifier.active);

  if (modifiers.length < 2) return { error: '请至少使用两个修饰键，避免和应用内快捷键冲突。' };

  const key = keyboardShortcutKey(event.key);
  if (!key.accelerator) return { error: '这个按键不能作为快捷键。' };

  return {
    shortcut: {
      accelerator: [...modifiers.map((modifier) => modifier.accelerator), key.accelerator].join('+'),
      keys: [...modifiers.map((modifier) => modifier.display), key.display],
    },
  };
};
const currentWindowMode = (): AppWindowMode => {
  if (window.location.search.includes(`window=${QUICK_WINDOW_LABEL}`)) return QUICK_WINDOW_LABEL;
  if (!isTauri()) return 'main';
  return getCurrentWindow().label === QUICK_WINDOW_LABEL ? 'quick-search' : 'main';
};

const getTauriWindow = async (label: string) => (isTauri() ? WebviewWindow.getByLabel(label) : null);

const openQuickSearchWindow = async () => {
  const quickWindow = await getTauriWindow(QUICK_WINDOW_LABEL);
  if (!quickWindow) return;
  await quickWindow.show();
  await quickWindow.setFocus();
};

const hideQuickSearchWindow = async () => {
  const quickWindow = await getTauriWindow(QUICK_WINDOW_LABEL);
  await quickWindow?.hide();
};

const focusMainWindow = async () => {
  const mainWindow = await getTauriWindow('main');
  if (!mainWindow) return;
  await mainWindow.show();
  await mainWindow.setFocus();
};

const hideCurrentWindow = async () => {
  if (!isTauri()) return;
  await getCurrentWindow().hide();
};

const writeClipboard = async (value: string) => {
  if (isTauri()) {
    await api.copyText(value);
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the execCommand-based path for browser previews.
    }
  }
  await api.copyText(value);
};

const itemTypes: Array<{ type: ItemType; label: string; icon: JSX.Element; implemented: boolean }> = [
  { type: 'login', label: '登录信息', icon: <KeyRound />, implemented: true },
  { type: 'secure_note', label: '安全备注', icon: <FileText />, implemented: false },
  { type: 'credit_card', label: '信用卡', icon: <CreditCard />, implemented: false },
  { type: 'identity', label: '身份标识', icon: <IdCard />, implemented: false },
  { type: 'password', label: '密码', icon: <KeyRound />, implemented: true },
  { type: 'document', label: '文档', icon: <FileText />, implemented: false },
];

const categoryOptions: Array<{ value: CategoryFilter; label: string; icon: JSX.Element }> = [
  { value: 'all', label: '所有类别', icon: <Grid2X2 /> },
  ...itemTypes.map((item) => ({ value: item.type, label: item.label, icon: item.icon })),
];

const moreItemTypes: Array<{ label: string; icon: JSX.Element }> = [
  { label: 'SSH 密钥', icon: <SquareTerminal /> },
  { label: 'API 凭据', icon: <Braces /> },
  { label: '会员信息', icon: <BadgeCheck /> },
  { label: '加密钱包', icon: <WalletCards /> },
  { label: '医疗记录', icon: <HeartPulse /> },
  { label: '奖励', icon: <Gift /> },
  { label: '户外许可证', icon: <Trees /> },
  { label: '护照', icon: <BookUser /> },
  { label: '数据库', icon: <Database /> },
  { label: '无线路由器', icon: <Wifi /> },
  { label: '服务器', icon: <Server /> },
  { label: '电子邮件', icon: <Mail /> },
  { label: '社会保险号码', icon: <ShieldCheck /> },
  { label: '软件许可', icon: <BadgeCheck /> },
  { label: '银行账户', icon: <Landmark /> },
  { label: '驾驶执照', icon: <CarFront /> },
  { label: '银行卡', icon: <Banknote /> },
];

const passwordGeneratorTypes: Array<{ value: PasswordGeneratorType; label: string }> = [
  { value: 'random', label: '随机密码' },
  { value: 'memorable', label: '易记密码' },
  { value: 'pin', label: 'PIN 码' },
];

const memorablePasswordWords = [
  'river',
  'mint',
  'solar',
  'paper',
  'north',
  'copper',
  'forest',
  'pixel',
  'orbit',
  'summer',
  'quiet',
  'stone',
];

const fallbackLogin: LoginInput = {
  title: '',
  username: '',
  password: '',
  website: '',
  websites: [''],
  website_labels: ['网站'],
  totp_secret: '',
  notes: '',
  tags: [],
};

const fallbackPassword: PasswordInput = {
  title: '',
  password: '',
  notes: '',
  tags: [],
};

const defaultWebsiteLabel = '网站';
const websiteLabelOrDefault = (label?: string) => (label?.trim() ? label : defaultWebsiteLabel);

const websitesForLogin = (input: Pick<LoginInput, 'website' | 'websites'>) =>
  input.websites.length > 0 ? input.websites : [input.website];

const websiteLabelsForLogin = (input: Pick<LoginInput, 'website' | 'websites' | 'website_labels'>) => {
  const websites = websitesForLogin(input);
  return websites.map((_, index) => input.website_labels[index] ?? defaultWebsiteLabel);
};

const websitePatch = (
  websites: string[],
  labels?: string[],
): Pick<LoginInput, 'website' | 'websites' | 'website_labels'> => {
  const nextWebsites = websites.length > 0 ? websites : [''];
  const primaryWebsite = nextWebsites.find((website) => website.trim().length > 0) ?? nextWebsites[0] ?? '';
  return {
    website: primaryWebsite,
    websites: nextWebsites,
    website_labels: nextWebsites.map((_, index) => labels?.[index] ?? defaultWebsiteLabel),
  };
};

export function App() {
  const [mode] = useState<AppWindowMode>(() => currentWindowMode());
  return (
    <AppErrorBoundary>
      {mode === 'quick-search' ? <QuickSearchWindow /> : <MainApp />}
    </AppErrorBoundary>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('界面渲染出错', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="auth-shell">
          <div className="auth-card">
            <div className="auth-mark">
              <Lock size={34} />
            </div>
            <h1>界面出现问题</h1>
            <p>渲染时发生错误：{this.state.error.message || String(this.state.error)}</p>
            <button className="primary-button auth-submit" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MainApp() {
  const [status, setStatus] = useState<VaultStatus>('locked');
  const [vaultProfile, setVaultProfile] = useState<VaultProfile>(DEFAULT_VAULT_PROFILE);
  const [items, setItems] = useState<ItemOverview[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedItem, setSelectedItem] = useState<VaultItem>();
  const [query, setQuery] = useState('');
  const [sidebarView, setSidebarView] = useState<SidebarView>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(sidebarWidthLimits.default);
  const [itemListWidth, setItemListWidth] = useState(itemListWidthLimits.default);
  const [resizingPane, setResizingPane] = useState<ResizablePane>();
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [error, setError] = useState('');
  const [pairingRequest, setPairingRequest] = useState<BridgePairingRequest>();
  const [pairingBusy, setPairingBusy] = useState(false);
  const [idleLockMinutes, setIdleLockMinutes] = useState(10);

  const shellStyle = useMemo(
    () =>
      ({
        '--sidebar-width': `${sidebarWidth}px`,
        '--item-list-width': `${itemListWidth}px`,
      }) as CSSProperties,
    [itemListWidth, sidebarWidth],
  );

  const refreshItems = useCallback(async () => {
    const nextItems = await api.listItems();
    setItems(nextItems);
    setSelectedId((current) => current ?? nextItems[0]?.id);
  }, []);

  const refreshVaultProfile = useCallback(async () => {
    setVaultProfile(await api.getVaultProfile());
  }, []);

  useEffect(() => {
    api
      .getStatus()
      .then(async (nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus !== 'no_vault') await refreshVaultProfile();
        if (nextStatus === 'unlocked') await refreshItems();
      })
      .catch((err) => setError(String(err)));
  }, [refreshItems, refreshVaultProfile]);

  useEffect(() => {
    if (status !== 'unlocked' || !selectedId) {
      setSelectedItem(undefined);
      return;
    }
    api.getItem(selectedId).then(setSelectedItem).catch((err) => setError(String(err)));
  }, [selectedId, status]);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let dispose: (() => void) | undefined;
    void listen<BridgePairingRequest>('bridge-pairing-request', (event) => {
      setPairingRequest(event.payload);
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  useEffect(() => {
    const loadIdleMinutes = () => {
      api
        .getIdleLockMinutes()
        .then((minutes) => setIdleLockMinutes(Number.isFinite(minutes) ? minutes : 10))
        .catch(() => {});
    };
    loadIdleMinutes();
    window.addEventListener('focus', loadIdleMinutes);
    return () => window.removeEventListener('focus', loadIdleMinutes);
  }, []);

  useEffect(() => {
    if (status !== 'unlocked' || idleLockMinutes <= 0) return undefined;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            const nextStatus = await api.lock();
            if (nextStatus === 'locked') {
              setSelectedId(undefined);
              setSelectedItem(undefined);
              setStatus('locked');
              await hideQuickSearchWindow();
            }
          } catch {
            // Ignore; user can still lock manually.
          }
        })();
      }, idleLockMinutes * 60_000);
    };
    const events: Array<keyof WindowEventMap> = ['mousemove', 'keydown', 'mousedown', 'scroll'];
    events.forEach((event) => window.addEventListener(event, arm, { passive: true }));
    arm();
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, arm));
    };
  }, [status, idleLockMinutes]);

  const respondPairing = async (allow: boolean) => {
    if (!pairingRequest) return;
    setPairingBusy(true);
    try {
      await api.approveBridgeOrigin(pairingRequest.origin, allow);
    } catch (err) {
      setError(String(err));
    } finally {
      setPairingBusy(false);
      setPairingRequest(undefined);
    }
  };

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      if (sidebarView === 'favorites' && !item.favorite) return false;
      if (categoryFilter !== 'all' && item.item_type !== categoryFilter) return false;
      if (!normalized) return true;
      return [item.title, item.subtitle, item.website].some((value) => value?.toLowerCase().includes(normalized));
    });
  }, [categoryFilter, items, query, sidebarView]);

  useEffect(() => {
    if (status !== 'unlocked') return;
    if (filteredItems.length === 0) {
      setSelectedId(undefined);
      return;
    }
    if (!selectedId || !filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0].id);
    }
  }, [filteredItems, selectedId, status]);

  const handleUnlocked = async (nextStatus: VaultStatus) => {
    setStatus(nextStatus);
    setError('');
    if (nextStatus === 'unlocked') {
      await refreshVaultProfile();
      await refreshItems();
    }
  };

  const handleFavoriteChange = async (id: string, favorite: boolean) => {
    const updatedItem = await api.setFavorite(id, favorite);
    setSelectedItem(updatedItem);
    setItems((currentItems) =>
      currentItems.map((item) => (item.id === updatedItem.id ? { ...item, favorite: updatedItem.favorite } : item)),
    );
  };

  const handleItemUpdate = async (id: string, input: EditableItemInput) => {
    const updatedItem = await api.updateItem(id, input);
    setSelectedItem(updatedItem);
    await refreshItems();
    setSelectedId(updatedItem.id);
    return updatedItem;
  };

  const handleLock = async () => {
    const nextStatus = await api.lock();
    setStatus(nextStatus);
    setSelectedId(undefined);
    setSelectedItem(undefined);
    await hideQuickSearchWindow();
  };

  const setPaneWidth = useCallback((pane: ResizablePane, value: number) => {
    if (pane === 'sidebar') {
      setSidebarWidth(clamp(value, sidebarWidthLimits.min, sidebarWidthLimits.max));
      return;
    }
    setItemListWidth(clamp(value, itemListWidthLimits.min, itemListWidthLimits.max));
  }, []);

  const beginPaneResize = useCallback(
    (pane: ResizablePane, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = pane === 'sidebar' ? sidebarWidth : itemListWidth;
      setResizingPane(pane);
      document.body.classList.add('is-resizing-pane');

      const onPointerMove = (moveEvent: PointerEvent) => {
        setPaneWidth(pane, startWidth + moveEvent.clientX - startX);
      };
      const stopResize = () => {
        setResizingPane(undefined);
        document.body.classList.remove('is-resizing-pane');
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', stopResize);
        window.removeEventListener('pointercancel', stopResize);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    },
    [itemListWidth, setPaneWidth, sidebarWidth],
  );

  const handlePaneResizeKey = useCallback(
    (pane: ResizablePane, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      const currentWidth = pane === 'sidebar' ? sidebarWidth : itemListWidth;
      setPaneWidth(pane, currentWidth + direction * 12);
    },
    [itemListWidth, setPaneWidth, sidebarWidth],
  );

  if (status === 'no_vault') {
    return <SetupScreen error={error} onError={setError} onReady={handleUnlocked} />;
  }

  if (status === 'locked') {
    return <UnlockScreen error={error} onError={setError} onReady={handleUnlocked} />;
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={shellStyle}>
      {!sidebarCollapsed && (
        <>
          <Sidebar
            vaultProfile={vaultProfile}
            selectedView={sidebarView}
            onViewChange={setSidebarView}
            onToggleSidebar={() => setSidebarCollapsed(true)}
            onOpenSettings={() => setOverlay({ kind: 'settings' })}
            onLock={handleLock}
          />
          <PaneResizer
            className="sidebar-resizer"
            active={resizingPane === 'sidebar'}
            label="调整侧边栏宽度"
            onPointerDown={(event) => beginPaneResize('sidebar', event)}
            onKeyDown={(event) => handlePaneResizeKey('sidebar', event)}
          />
        </>
      )}
      <main className="main-area">
        <TopToolbar
          vaultProfile={vaultProfile}
          query={query}
          sidebarCollapsed={sidebarCollapsed}
          onQueryChange={setQuery}
          onToggleSidebar={() => setSidebarCollapsed(false)}
          onOpenQuickSearch={() => void openQuickSearchWindow()}
          onNewItem={() => setOverlay({ kind: 'type-picker' })}
        />
        <section className="content-split">
          <ItemListPane
            items={filteredItems}
            selectedId={selectedId}
            sidebarCollapsed={sidebarCollapsed}
            viewTitle={sidebarView === 'favorites' ? '收藏夹' : '所有项目'}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
            onSelect={setSelectedId}
          />
          <PaneResizer
            className="item-list-resizer"
            active={resizingPane === 'itemList'}
            label="调整项目列表宽度"
            onPointerDown={(event) => beginPaneResize('itemList', event)}
            onKeyDown={(event) => handlePaneResizeKey('itemList', event)}
          />
          <DetailPane
            item={selectedItem}
            vaultProfile={vaultProfile}
            onFavoriteChange={handleFavoriteChange}
            onItemUpdate={handleItemUpdate}
          />
        </section>
      </main>

      {overlay.kind === 'type-picker' && (
        <TypePickerModal
          onClose={() => setOverlay({ kind: 'none' })}
          onPick={(itemType) => setOverlay({ kind: 'editor', itemType })}
        />
      )}

      {overlay.kind === 'editor' && (
        <ItemEditorModal
          itemType={overlay.itemType}
          onClose={() => setOverlay({ kind: 'none' })}
          onSaveLogin={async (input) => {
            const item = await api.createLogin(input);
            await refreshItems();
            setSelectedId(item.id);
            setSelectedItem(item);
            setOverlay({ kind: 'none' });
          }}
          onSavePassword={async (input) => {
            const item = await api.createPassword(input);
            await refreshItems();
            setSelectedId(item.id);
            setSelectedItem(item);
            setOverlay({ kind: 'none' });
          }}
        />
      )}

      {overlay.kind === 'settings' && (
        <SettingsModal
          onClose={() => setOverlay({ kind: 'none' })}
          idleLockMinutes={idleLockMinutes}
          onIdleLockMinutesChange={setIdleLockMinutes}
        />
      )}

      {pairingRequest && (
        <div className="overlay">
          <div className="modal-card pairing-modal" role="alertdialog" aria-modal="true" aria-labelledby="pairing-title">
            <div className="auth-mark pairing-mark">
              <ShieldCheck size={30} />
            </div>
            <h2 id="pairing-title">允许浏览器扩展访问？</h2>
            <p className="pairing-origin">
              来自 <strong>{pairingRequest.origin}</strong> 的登录页请求读取匹配的凭据（含 MFA 验证码）。
            </p>
            <p className="pairing-note">仅在你信任该网站时允许。授权后可随时在「设置 → 浏览器扩展」中撤销。</p>
            <div className="pairing-actions">
              <button className="secondary-button" disabled={pairingBusy} onClick={() => void respondPairing(false)}>
                拒绝
              </button>
              <button className="primary-button" disabled={pairingBusy} onClick={() => void respondPairing(true)}>
                {pairingBusy ? '处理中...' : '永久允许'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SetupScreen({
  error,
  onError,
  onReady,
}: {
  error: string;
  onError: (value: string) => void;
  onReady: (status: VaultStatus) => void;
}) {
  const [profileName, setProfileName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmedProfileName = profileName.trim();
    if (!trimmedProfileName) {
      onError('请输入用户名。');
      return;
    }
    if (trimmedProfileName.length > 40) {
      onError('用户名不能超过 40 个字符。');
      return;
    }
    if (password.length < 8) {
      onError('主密码至少需要 8 个字符。');
      return;
    }
    if (password !== confirmPassword) {
      onError('两次输入的主密码不一致。');
      return;
    }
    setBusy(true);
    try {
      onReady(await api.initializeVault(trimmedProfileName, password));
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen
      title={`创建${APP_NAME}`}
      description="用户名只用于本机显示；主密码用于解锁本地加密数据。"
      error={error}
      profileName={profileName}
      password={password}
      confirmPassword={confirmPassword}
      busy={busy}
      submitLabel="创建并解锁"
      onProfileNameChange={setProfileName}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={submit}
    />
  );
}

function UnlockScreen({
  error,
  onError,
  onReady,
}: {
  error: string;
  onError: (value: string) => void;
  onReady: (status: VaultStatus) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      onReady(await api.unlock(password));
    } catch {
      onError('无法解锁。请检查主密码。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen
      title={`${APP_NAME} 已锁定`}
      description="输入主密码后才会在内存中解开本地密钥。"
      error={error}
      password={password}
      busy={busy}
      submitLabel="解锁"
      onPasswordChange={setPassword}
      onSubmit={submit}
    />
  );
}

function AuthScreen({
  title,
  description,
  error,
  password,
  confirmPassword,
  profileName,
  busy,
  submitLabel,
  onProfileNameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: {
  title: string;
  description: string;
  error: string;
  profileName?: string;
  password: string;
  confirmPassword?: string;
  busy: boolean;
  submitLabel: string;
  onProfileNameChange?: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange?: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-mark">
          <Lock size={34} />
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
        {onProfileNameChange && (
          <label className="auth-field">
            <span>用户名</span>
            <input
              autoFocus
              type="text"
              value={profileName}
              placeholder="例如：起飞"
              onChange={(event) => onProfileNameChange(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
            />
          </label>
        )}
        <label className="auth-field">
          <span>主密码</span>
          <input
            autoFocus={!onProfileNameChange}
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
          />
        </label>
        {onConfirmPasswordChange && (
          <label className="auth-field">
            <span>确认主密码</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => onConfirmPasswordChange(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
            />
          </label>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button className="primary-button auth-submit" disabled={busy} onClick={onSubmit}>
          {busy ? '处理中...' : submitLabel}
        </button>
      </div>
    </div>
  );
}

const normalizedQuickQuery = (value: string) => value.trim().toLowerCase();

const quickItemMatches = (item: ItemOverview, query: string) => {
  if (!query) return true;
  return [item.title, item.subtitle, item.website].some((value) => value?.toLowerCase().includes(query));
};

const quickCopyFieldsForItem = (item: VaultItem): QuickCopyField[] => {
  if (item.item_type === 'password') {
    return [
      { id: 'password', label: '密码', value: item.password, secret: true, primary: true },
      ...(item.notes.trim() ? [{ id: 'notes', label: '备注', value: item.notes }] : []),
    ];
  }

  const websites = item.websites?.length ? item.websites : [item.website];
  const websiteFields: QuickCopyField[] = websites
    .map((website, index) => ({
      id: `website-${index}`,
      label: websiteLabelOrDefault(item.website_labels?.[index]),
      value: website,
    }))
    .filter((field) => field.value.trim().length > 0);

  return [
    { id: 'username', label: '用户名', value: item.username },
    { id: 'password', label: '密码', value: item.password, secret: true, primary: true },
    ...websiteFields,
    ...(item.notes.trim() ? [{ id: 'notes', label: '备注', value: item.notes }] : []),
  ];
};

function QuickSearchWindow() {
  const [status, setStatus] = useState<VaultStatus>('locked');
  const [items, setItems] = useState<ItemOverview[]>([]);
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState<number>();
  const [activeItemId, setActiveItemId] = useState<string>();
  const [selectedItem, setSelectedItem] = useState<VaultItem>();
  const [expanded, setExpanded] = useState(true);
  const [pinned, setPinned] = useState(false);
  const [copiedFieldId, setCopiedFieldId] = useState<string>();
  const [totpState, setTotpState] = useState<{ code: string; remaining: number }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const refreshQuickState = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextStatus = await api.getStatus();
      setStatus(nextStatus);
      if (nextStatus !== 'unlocked') {
        setItems([]);
        setSelectedItem(undefined);
        setActiveItemId(undefined);
        return;
      }
      const nextItems = await api.listItems();
      setItems(nextItems);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshQuickState();
    const focusSearch = () => {
      void refreshQuickState();
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, [refreshQuickState]);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let dispose: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void hideCurrentWindow();
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  const filteredItems = useMemo(() => {
    const normalizedQuery = normalizedQuickQuery(query);
    if (!normalizedQuery) return [];
    return items
      .filter((item) => quickItemMatches(item, normalizedQuery))
      .sort((left, right) => {
        if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
        return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
      })
      .slice(0, 8);
  }, [items, query]);

  useEffect(() => {
    setFocusedIndex(undefined);
    setActiveItemId(undefined);
    setSelectedItem(undefined);
  }, [query]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      setFocusedIndex(undefined);
      return;
    }
    if (focusedIndex !== undefined && focusedIndex >= filteredItems.length) {
      setFocusedIndex(filteredItems.length - 1);
    }
  }, [filteredItems.length, focusedIndex]);

  const selectedOverview = activeItemId
    ? filteredItems.find((item) => item.id === activeItemId) ?? items.find((item) => item.id === activeItemId)
    : undefined;
  const hasQuery = normalizedQuickQuery(query).length > 0;

  useEffect(() => {
    let cancelled = false;
    if (status !== 'unlocked' || !selectedOverview) {
      setSelectedItem(undefined);
      return undefined;
    }
    api
      .getItem(selectedOverview.id)
      .then((item) => {
        if (!cancelled) setSelectedItem(item);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedOverview, status]);

  useEffect(() => {
    setTotpState(undefined);
    if (status !== 'unlocked' || selectedItem?.item_type !== 'login' || !selectedItem.totp_secret?.trim()) {
      return undefined;
    }
    let cancelled = false;
    const itemId = selectedItem.id;
    const tick = async () => {
      try {
        const next = await api.getTotp(itemId);
        if (!cancelled) setTotpState(next ? { code: next.code, remaining: next.remaining_seconds } : undefined);
      } catch {
        if (!cancelled) setTotpState(undefined);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedItem, status]);

  const quickFields = useMemo(() => {
    if (!selectedItem) return [] as QuickCopyField[];
    const fields = quickCopyFieldsForItem(selectedItem);
    if (
      totpState &&
      selectedItem.item_type === 'login' &&
      selectedItem.totp_secret?.trim()
    ) {
      fields.push({ id: 'totp', label: 'MFA 验证码', value: totpState.code });
    }
    return fields;
  }, [selectedItem, totpState]);
  const primaryField = quickFields.find((field) => field.primary) ?? quickFields[0];
  const visibleFields = expanded ? quickFields : quickFields.slice(0, 2);
  const clearQuickSearch = useCallback(() => {
    setQuery('');
    setFocusedIndex(undefined);
    setActiveItemId(undefined);
    setSelectedItem(undefined);
    setCopiedFieldId(undefined);
    setExpanded(true);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!isTauri() || status !== 'unlocked') return;

    const resultRows = hasQuery ? Math.min(filteredItems.length || 1, 5) : 0;
    const resultBlockHeight = resultRows * 55;
    const detailHeight = selectedOverview ? visibleFields.length * 44 + (quickFields.length > 2 ? 34 : 0) : 0;
    const baseHeight = 34 + 58 + 34;
    const nextHeight = selectedOverview
      ? clamp(baseHeight + resultBlockHeight + detailHeight + 10, 300, 500)
      : clamp(baseHeight + resultBlockHeight, hasQuery ? 200 : 180, 400);

    void getCurrentWindow()
      .setSize(new LogicalSize(quickWindowWidth, Math.round(nextHeight)))
      .catch((err) => console.warn('Unable to resize quick search window', err));
  }, [filteredItems.length, hasQuery, quickFields.length, selectedOverview, status, visibleFields.length]);

  const copyQuickField = async (field: QuickCopyField) => {
    const nextStatus = await api.getStatus();
    if (nextStatus !== 'unlocked') {
      setStatus(nextStatus);
      setSelectedItem(undefined);
      return;
    }

    try {
      await writeClipboard(field.value);
      setError('');
      setCopiedFieldId(field.id);
      window.setTimeout(() => setCopiedFieldId((current) => (current === field.id ? undefined : current)), 1200);
    } catch (err) {
      setError(`复制失败：${String(err)}`);
      return;
    }

    if (!pinned) {
      window.setTimeout(() => void hideCurrentWindow(), 360);
    }
  };

  const togglePinned = async () => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    if (isTauri()) {
      await getCurrentWindow().setAlwaysOnTop(nextPinned);
    }
  };

  const handleQuickKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      if (query.trim().length > 0 || activeItemId) {
        clearQuickSearch();
        return;
      }
      if (pinned) {
        clearQuickSearch();
        return;
      }
      void hideCurrentWindow();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusedIndex((current) => {
        if (filteredItems.length === 0) return undefined;
        return Math.min((current ?? -1) + 1, filteredItems.length - 1);
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedIndex((current) => {
        if (filteredItems.length === 0) return undefined;
        return Math.max((current ?? filteredItems.length) - 1, 0);
      });
      return;
    }

    if (event.key === 'ArrowRight') {
      setExpanded(true);
      return;
    }

    if (event.key === 'ArrowLeft') {
      setExpanded(false);
      return;
    }

    const numericShortcut = Number(event.key);
    if ((event.metaKey || event.ctrlKey) && numericShortcut >= 1 && numericShortcut <= visibleFields.length) {
      event.preventDefault();
      void copyQuickField(visibleFields[numericShortcut - 1]);
      return;
    }

    if (event.key === 'Enter' && primaryField) {
      event.preventDefault();
      void copyQuickField(primaryField);
    }
  };

  if (status !== 'unlocked') {
    return (
      <section className={`quick-shell quick-locked ${isTauri() ? 'native-titlebar' : ''}`} onMouseDown={startWindowDrag}>
        <header className="quick-titlebar" />
        <div className="quick-locked-body">
          <div className="auth-mark quick-auth-mark">
            <Lock size={30} />
          </div>
          <h1>{APP_NAME} 已锁定</h1>
          <p>请先在主窗口解锁。</p>
          <button className="primary-button" onClick={() => void focusMainWindow()}>
            打开主窗口
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`quick-shell ${isTauri() ? 'native-titlebar' : ''}`} onKeyDown={handleQuickKeyDown}>
      <header className="quick-titlebar" data-tauri-drag-region onMouseDown={startWindowDrag}>
        <div className="quick-window-actions">
          <button className={`icon-button quick-pin-button ${pinned ? 'active' : ''}`} aria-label="钉住迷你查询" onClick={() => void togglePinned()}>
            {pinned ? <PinOff size={18} /> : <Pin size={18} />}
          </button>
        </div>
      </header>

      <label className="quick-search-box">
        <Search size={20} />
        <input
          ref={searchInputRef}
          value={query}
          placeholder="搜索项目"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {error && <div className="quick-error">{error}</div>}

      <div className={`quick-content ${selectedOverview ? '' : 'no-active'}`}>
        <div className={`quick-results ${!hasQuery ? 'empty-query' : ''}`} role="listbox" aria-label="迷你查询结果">
          {loading && <div className="quick-empty">正在读取...</div>}
          {!loading && !hasQuery && <div className="quick-empty">输入关键词查找项目</div>}
          {!loading && hasQuery && filteredItems.length === 0 && <div className="quick-empty">没有匹配项目</div>}
          {filteredItems.map((item, index) => (
            <button
              key={item.id}
              className={`quick-result-row ${item.id === activeItemId ? 'selected' : ''} ${
                index === focusedIndex && item.id !== activeItemId ? 'focused' : ''
              }`}
              role="option"
              aria-selected={item.id === activeItemId}
              onMouseEnter={() => setFocusedIndex(index)}
              onClick={() => {
                setFocusedIndex(index);
                setActiveItemId(item.id);
                setExpanded(true);
              }}
            >
              <ItemIcon item={item} />
              <span className="quick-result-text">
                <strong>{item.title}</strong>
                <span>{item.subtitle || item.website || '密码'}</span>
              </span>
            </button>
          ))}
        </div>

        {selectedOverview && (
          <div className="quick-detail">
            <div className="quick-field-list">
              {visibleFields.map((field, index) => (
                <button
                  type="button"
                  key={field.id}
                  className={`quick-copy-field ${copiedFieldId === field.id ? 'copied' : ''}`}
                  aria-label={`复制${field.label}`}
                  onClick={() => void copyQuickField(field)}
                >
                  <span className="quick-copy-label">
                    <span>{field.label}</span>
                  </span>
                  <strong className={field.secret ? 'password-value' : undefined}>
                    {field.secret ? '••••••••••' : field.value || '空'}
                  </strong>
                  {copiedFieldId === field.id && <span className="quick-copy-state">已复制</span>}
                </button>
              ))}
            </div>

            {quickFields.length > 2 && (
              <button className="quick-expand-button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? '收起' : '显示更多'}
                <ChevronDown size={16} className={expanded ? 'rotate-left' : ''} />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Sidebar({
  vaultProfile,
  selectedView,
  onViewChange,
  onToggleSidebar,
  onOpenSettings,
  onLock,
}: {
  vaultProfile: VaultProfile;
  selectedView: SidebarView;
  onViewChange: (view: SidebarView) => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onLock: () => void;
}) {
  return (
    <aside className="sidebar" data-tauri-drag-region="deep" onMouseDown={startWindowDrag}>
      <button className="sidebar-toggle-button" aria-label="折叠侧边栏" onClick={onToggleSidebar}>
        <PanelLeftClose size={22} />
      </button>
      <div className="sidebar-account">
        <div className="avatar">{vaultProfile.avatar}</div>
        <div className="account-name">{vaultProfile.name}</div>
        <ChevronDown size={18} />
      </div>
      <nav className="sidebar-nav">
        <SidebarButton icon={<Archive />} label="所有项目" selected={selectedView === 'all'} onClick={() => onViewChange('all')} />
        <SidebarButton
          icon={<Star />}
          label="收藏夹"
          selected={selectedView === 'favorites'}
          tone="favorite"
          onClick={() => onViewChange('favorites')}
        />
      </nav>
      <div className="sidebar-footer">
        <button className="sidebar-button compact" onClick={onOpenSettings}>
          <Settings size={17} />
          <span>设置</span>
        </button>
        <button className="sidebar-button compact" onClick={onLock}>
          <LogOut size={17} />
          <span>锁定</span>
        </button>
      </div>
    </aside>
  );
}

function PaneResizer({
  className,
  active,
  label,
  onPointerDown,
  onKeyDown,
}: {
  className: string;
  active: boolean;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`pane-resizer ${className} ${active ? 'active' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

function SidebarButton({
  icon,
  label,
  selected,
  compact,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  selected?: boolean;
  compact?: boolean;
  tone?: 'favorite';
  onClick?: () => void;
}) {
  return (
    <button
      className={`sidebar-button ${selected ? 'selected' : ''} ${compact ? 'compact' : ''} ${tone ? `tone-${tone}` : ''}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function TopToolbar({
  vaultProfile,
  query,
  sidebarCollapsed,
  onQueryChange,
  onToggleSidebar,
  onOpenQuickSearch,
  onNewItem,
}: {
  vaultProfile: VaultProfile;
  query: string;
  sidebarCollapsed: boolean;
  onQueryChange: (value: string) => void;
  onToggleSidebar: () => void;
  onOpenQuickSearch: () => void;
  onNewItem: () => void;
}) {
  return (
    <header
      className={`top-toolbar ${sidebarCollapsed ? 'with-sidebar-toggle' : ''}`}
      data-tauri-drag-region="deep"
      onMouseDown={startWindowDrag}
    >
      {sidebarCollapsed && (
        <button className="icon-button toolbar-sidebar-toggle" aria-label="展开侧边栏" onClick={onToggleSidebar}>
          <PanelLeftOpen size={21} />
        </button>
      )}
      <label className="global-search">
        <Search size={20} />
        <input value={query} placeholder={`在“${vaultProfile.name}”中搜索`} onChange={(event) => onQueryChange(event.target.value)} />
      </label>
      <button className="icon-button quick-tool-trigger" aria-label="打开迷你查询" onClick={onOpenQuickSearch}>
        <Command size={20} />
      </button>
      <button className="link-button">帮助</button>
      <button className="primary-button new-item" onClick={onNewItem}>
        <Plus size={21} />
        新的项目
      </button>
    </header>
  );
}

function ItemListPane({
  items,
  selectedId,
  sidebarCollapsed,
  viewTitle,
  categoryFilter,
  onCategoryChange,
  onSelect,
}: {
  items: ItemOverview[];
  selectedId?: string;
  sidebarCollapsed: boolean;
  viewTitle: string;
  categoryFilter: CategoryFilter;
  onCategoryChange: (category: CategoryFilter) => void;
  onSelect: (id: string) => void;
}) {
  const [categoryOpen, setCategoryOpen] = useState(false);
  const selectedCategory = categoryOptions.find((option) => option.value === categoryFilter) ?? categoryOptions[0];

  return (
    <section className="item-list-pane">
      <div className={`list-head ${sidebarCollapsed ? 'with-title' : ''}`}>
        {sidebarCollapsed && <h2 className="list-title">{viewTitle}</h2>}
        <div className="list-controls">
          <div className="category-control">
            <button
              className={`category-button ${categoryFilter !== 'all' ? 'filtered' : ''}`}
              aria-expanded={categoryOpen}
              onClick={() => setCategoryOpen((value) => !value)}
            >
              <span className={`category-button-icon category-icon-${selectedCategory.value}`}>{selectedCategory.icon}</span>
              {selectedCategory.label}
              <ChevronDown size={17} />
            </button>
            {categoryOpen && (
              <div className="category-menu">
                {categoryOptions.map((option, index) => (
                  <button
                    key={option.value}
                    className={`category-option ${option.value === categoryFilter ? 'selected' : ''} ${
                      index === 1 ? 'after-divider' : ''
                    }`}
                    onClick={() => {
                      onCategoryChange(option.value);
                      setCategoryOpen(false);
                    }}
                  >
                    <span className={`category-option-icon category-icon-${option.value}`}>{option.icon}</span>
                    <span>{option.label}</span>
                    {option.value === categoryFilter && <Check className="category-check" size={22} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="list-tools">
            <button className="icon-button" aria-label="筛选">
              <Search size={18} />
            </button>
            <button className="icon-button" aria-label="排序">
              <ListFilter size={18} />
            </button>
          </div>
        </div>
      </div>
      <div className="month-label">2026年6月</div>
      <div className="item-list" role="listbox" aria-label="Item list">
        {items.map((item) => (
          <button
            key={item.id}
            className={`item-row ${item.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(item.id)}
          >
            <ItemIcon item={item} />
            <span className="item-row-text">
              <strong>{item.title}</strong>
              <span>{item.subtitle}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ItemIcon({ item }: { item: ItemOverview }) {
  const initials = item.icon_text.slice(0, 2);
  const isOpenAi = item.title.toLowerCase().includes('openai');
  if (item.item_type === 'password') {
    return (
      <span className="item-icon item-icon-password">
        <KeyRound size={22} />
      </span>
    );
  }
  return <span className={`item-icon ${isOpenAi ? 'black' : ''}`}>{isOpenAi ? '◎' : initials}</span>;
}

function DetailPane({
  item,
  vaultProfile,
  onFavoriteChange,
  onItemUpdate,
}: {
  item?: VaultItem;
  vaultProfile: VaultProfile;
  onFavoriteChange: (id: string, favorite: boolean) => Promise<void>;
  onItemUpdate: (id: string, input: EditableItemInput) => Promise<VaultItem>;
}) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string>();
  const itemWebsites = item?.item_type === 'login' ? item.websites?.length ? item.websites : [item.website] : [];
  const itemWebsiteLabels =
    item?.item_type === 'login'
      ? itemWebsites.map((_, index) => websiteLabelOrDefault(item.website_labels?.[index]))
      : [];

  useEffect(() => {
    setRevealed(false);
    setEditing(false);
  }, [item?.id]);

  if (!item) {
    return (
      <section className="detail-pane empty-detail">
        <div className="vault-illustration">
          <Lock size={74} />
        </div>
      </section>
    );
  }

  if (editing) {
    return (
      <ItemEditPane
        item={item}
        onCancel={() => setEditing(false)}
        onSave={async (input) => {
          await onItemUpdate(item.id, input);
          setEditing(false);
        }}
      />
    );
  }

  const copyValue = async (value: string, key?: string) => {
    try {
      await writeClipboard(value);
    } catch (err) {
      console.warn('Copy failed', err);
      return;
    }
    if (key) {
      setCopiedKey(key);
      window.setTimeout(
        () => setCopiedKey((current) => (current === key ? undefined : current)),
        1200,
      );
    }
  };

  return (
    <section className="detail-pane">
      <div className="detail-toolbar">
        <div className="detail-scope">
          <span className="mini-avatar">{vaultProfile.avatar}</span>
          <strong>{vaultProfile.name}</strong>
        </div>
        <div className="detail-actions">
          <button
            className={`detail-action favorite-action ${item.favorite ? 'active' : ''}`}
            onClick={() => onFavoriteChange(item.id, !item.favorite)}
          >
            <Star size={20} />
            {item.favorite ? '已收藏' : '收藏'}
          </button>
          <button className="detail-action">
            <Share size={20} />
            分享
          </button>
          <button className="detail-action" onClick={() => setEditing(true)}>
            <Edit3 size={20} />
            编辑
          </button>
          <button className="icon-button">
            <MoreVertical size={22} />
          </button>
        </div>
      </div>
      <div className="detail-content">
        <div className="detail-title-row">
          <span className={`detail-icon detail-icon-${item.item_type}`}>
            {item.item_type === 'password' ? <KeyRound size={34} /> : item.title.slice(0, 2)}
          </span>
          <h1>{item.title}</h1>
        </div>
        {item.item_type === 'login' ? (
          <>
            <div className="credential-card">
              <FieldLine
                label="用户名"
                value={item.username}
                actionLabel={copiedKey === 'username' ? '已复制' : '复制'}
                onAction={() => void copyValue(item.username, 'username')}
              />
              <SecretFieldLine
                password={item.password}
                revealed={revealed}
                copied={copiedKey === 'password'}
                onReveal={() => setRevealed((value) => !value)}
                onCopy={() => void copyValue(item.password, 'password')}
              />
              {item.totp_secret?.trim().length > 0 && <TotpFieldLine itemId={item.id} />}
            </div>
            {itemWebsites.map((website, index) => (
              <section className="detail-section" key={`${index}-${website}`}>
                <span className="field-label">{itemWebsiteLabels[index] ?? defaultWebsiteLabel}</span>
                <a href={website} target="_blank" rel="noreferrer">
                  {website}
                </a>
              </section>
            ))}
          </>
        ) : (
          <div className="credential-card">
            <SecretFieldLine
              password={item.password}
              revealed={revealed}
              highlighted
              copied={copiedKey === 'password'}
              onReveal={() => setRevealed((value) => !value)}
              onCopy={() => void copyValue(item.password, 'password')}
            />
          </div>
        )}
        {item.notes && (
          <section className="detail-section notes">
            {item.notes.split('\n').map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        )}
        {item.tags.length > 0 && (
          <section className="detail-section">
            <span className="field-label">标签</span>
            <div className="tag-row">
              {item.tags.map((tag) => (
                <span key={tag} className="tag-pill">
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}
        <button className="metadata-row">
          <ChevronDown size={18} className="rotate-right" />
          最后编辑 {new Date(item.updated_at).toLocaleString('zh-CN')}
        </button>
      </div>
    </section>
  );
}

const loginInputFromItem = (item: VaultItem): LoginInput => {
  if (item.item_type !== 'login') return fallbackLogin;
  const websites = item.websites?.length ? item.websites : [item.website];
  return {
    title: item.title,
    username: item.username,
    password: item.password,
    website: item.website,
    websites,
    website_labels: websites.map((_, index) => item.website_labels?.[index] ?? defaultWebsiteLabel),
    totp_secret: item.totp_secret ?? '',
    notes: item.notes,
    tags: item.tags,
  };
};

const passwordInputFromItem = (item: VaultItem): PasswordInput => {
  if (item.item_type !== 'password') return fallbackPassword;
  return {
    title: item.title,
    password: item.password,
    notes: item.notes,
    tags: item.tags,
  };
};

function ItemEditPane({
  item,
  onCancel,
  onSave,
}: {
  item: VaultItem;
  onCancel: () => void;
  onSave: (input: EditableItemInput) => Promise<void>;
}) {
  const typeConfig = itemTypes.find((entry) => entry.type === item.item_type) ?? itemTypes[0];
  const isPassword = item.item_type === 'password';
  const [loginInput, setLoginInput] = useState<LoginInput>(() => loginInputFromItem(item));
  const [passwordInput, setPasswordInput] = useState<PasswordInput>(() => passwordInputFromItem(item));
  const [generatorHint, setGeneratorHint] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    setLoginInput(loginInputFromItem(item));
    setPasswordInput(passwordInputFromItem(item));
    setSaveError('');
  }, [item]);

  const updateLogin = (patch: Partial<LoginInput>) => setLoginInput((current) => ({ ...current, ...patch }));
  const updatePassword = (patch: Partial<PasswordInput>) => setPasswordInput((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await onSave(
        isPassword
          ? { item_type: 'password', input: passwordInput }
          : { item_type: 'login', input: loginInput },
      );
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="detail-pane item-edit-pane">
      <header className="item-edit-header" data-tauri-drag-region="deep" onMouseDown={startWindowDrag}>
        <div className="item-edit-actions">
          <h2>编辑</h2>
          <button className="edit-cancel-button" disabled={saving} onClick={onCancel}>
            取消
          </button>
          <button className="primary-button edit-save-button" disabled={saving} onClick={save}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </header>
      <div className={`editor-body item-edit-body ${generatorOpen ? 'generator-open' : ''}`}>
        <div className="editor-elements item-edit-elements">
          <EditorTitle
            itemType={item.item_type}
            icon={typeConfig.icon}
            value={isPassword ? passwordInput.title : loginInput.title}
            onChange={(title) => (isPassword ? updatePassword({ title }) : updateLogin({ title }))}
          />
          {isPassword ? (
            <PasswordEditorFields
              input={passwordInput}
              generatorHint={generatorHint}
              generatorOpen={generatorOpen}
              onGeneratorHintChange={setGeneratorHint}
              onGeneratorOpenChange={setGeneratorOpen}
              onChange={updatePassword}
            />
          ) : (
            <LoginEditorFields
              input={loginInput}
              generatorHint={generatorHint}
              generatorOpen={generatorOpen}
              onGeneratorHintChange={setGeneratorHint}
              onGeneratorOpenChange={setGeneratorOpen}
              onChange={updateLogin}
            />
          )}
          {saveError && <div className="editor-error">{saveError}</div>}
        </div>
      </div>
    </section>
  );
}

function SecretFieldLine({
  password,
  revealed,
  highlighted,
  copied,
  onReveal,
  onCopy,
}: {
  password: string;
  revealed: boolean;
  highlighted?: boolean;
  copied?: boolean;
  onReveal: () => void;
  onCopy: () => void;
}) {
  return (
    <div className={`field-line ${highlighted ? 'highlighted' : ''}`}>
      <div>
        <span className="field-label">密码</span>
        <span className="field-value password-value">{revealed ? password : '••••••••••'}</span>
      </div>
      <div className="field-actions">
        <span className="strength">极佳</span>
        <span className="strength-ring" />
        <button className="icon-button" onClick={onReveal}>
          {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
        <button className="field-copy" onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}

function FieldLine({
  label,
  value,
  actionLabel,
  onAction,
}: {
  label: string;
  value: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="field-line highlighted">
      <div>
        <span className="field-label">{label}</span>
        <span className="field-value">{value}</span>
      </div>
      <button className="field-copy" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

function TotpFieldLine({ itemId }: { itemId: string }) {
  const [totp, setTotp] = useState<TotpCode>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await api.getTotp(itemId);
        if (!cancelled) setTotp(next ?? undefined);
      } catch {
        if (!cancelled) setTotp(undefined);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [itemId]);

  if (!totp) return null;

  const progress = Math.round((totp.remaining_seconds / totp.period_seconds) * 100);
  const formattedCode = `${totp.code.slice(0, 3)} ${totp.code.slice(3)}`;

  const copy = async () => {
    try {
      await writeClipboard(totp.code);
    } catch (err) {
      console.warn('Copy failed', err);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="field-line highlighted totp-line">
      <div>
        <span className="field-label">MFA 验证码</span>
        <span className="field-value totp-value">{formattedCode}</span>
      </div>
      <div className="field-actions">
        <span className="totp-countdown" aria-label={`${totp.remaining_seconds} 秒后刷新`}>
          {totp.remaining_seconds}s
        </span>
        <span
          className="totp-ring"
          style={{ '--totp-progress': `${progress}%` } as CSSProperties}
          aria-hidden="true"
        />
        <button className="field-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}

function SettingsModal({
  onClose,
  idleLockMinutes,
  onIdleLockMinutesChange,
}: {
  onClose: () => void;
  idleLockMinutes: number;
  onIdleLockMinutesChange: (minutes: number) => void;
}) {
  const [activeSection, setActiveSection] = useState<'general' | 'browser'>('general');
  const [savedShortcut, setSavedShortcut] = useState<ShortcutConfig>(() => defaultQuickAccessShortcut());
  const [draftShortcut, setDraftShortcut] = useState<ShortcutConfig>(() => defaultQuickAccessShortcut());
  const [recording, setRecording] = useState(false);
  const [shortcutMessage, setShortcutMessage] = useState('');
  const [savingShortcut, setSavingShortcut] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [openingRelease, setOpeningRelease] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const recorderRef = useRef<HTMLButtonElement>(null);
  const shortcutChanged = draftShortcut.accelerator !== savedShortcut.accelerator;

  useEffect(() => {
    let cancelled = false;
    api
      .getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        if (!cancelled) setAppVersion('');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getQuickAccessShortcut()
      .then((shortcut) => {
        if (cancelled) return;
        setSavedShortcut(shortcut);
        setDraftShortcut(shortcut);
      })
      .catch((err) => {
        if (!cancelled) setShortcutMessage(`读取快捷键失败：${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkForUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateMessage('');
    try {
      const info = await api.checkForUpdate();
      setUpdateInfo(info);
      setAppVersion(info.currentVersion);
      setUpdateMessage(info.available ? `发现新版本 ${info.latestVersion}。` : '已是最新版本。');
    } catch (err) {
      setUpdateMessage(`检查失败：${String(err)}`);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const openReleasePage = async () => {
    if (!updateInfo) return;
    setOpeningRelease(true);
    setUpdateMessage('');
    try {
      await api.openExternalUrl(updateInfo.releaseUrl);
    } catch (err) {
      setUpdateMessage(`打开失败：${String(err)}`);
    } finally {
      setOpeningRelease(false);
    }
  };

  const releaseDate = updateInfo?.publishedAt ? new Date(updateInfo.publishedAt) : null;
  const releaseDateText =
    releaseDate && !Number.isNaN(releaseDate.getTime())
      ? releaseDate.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '';
  const updateSummary = updateInfo
    ? updateInfo.available
      ? `GitHub 已发布 ${updateInfo.releaseName}${releaseDateText ? `，发布于 ${releaseDateText}` : ''}。`
      : `当前版本 ${updateInfo.currentVersion} 已是 GitHub 最新发布版本。`
    : `当前版本 ${appVersion || '读取中'}。`;

  const beginRecording = () => {
    setRecording(true);
    setShortcutMessage('请直接按下新的快捷键组合。');
    window.setTimeout(() => recorderRef.current?.focus(), 0);
  };

  const saveShortcut = async () => {
    setSavingShortcut(true);
    setShortcutMessage('');
    try {
      const shortcut = await api.setQuickAccessShortcut(draftShortcut);
      setSavedShortcut(shortcut);
      setDraftShortcut(shortcut);
      setShortcutMessage('已保存，快捷键已生效。');
    } catch (err) {
      setShortcutMessage(`保存失败：${String(err)}。可能已被其他应用占用。`);
    } finally {
      setSavingShortcut(false);
    }
  };

  const resetShortcut = async () => {
    const nextShortcut = defaultQuickAccessShortcut();
    setSavingShortcut(true);
    setRecording(false);
    setShortcutMessage('');
    try {
      const shortcut = await api.setQuickAccessShortcut(nextShortcut);
      setSavedShortcut(shortcut);
      setDraftShortcut(shortcut);
      setShortcutMessage('已恢复默认快捷键，并已生效。');
    } catch (err) {
      setShortcutMessage(`恢复失败：${String(err)}。可能已被其他应用占用。`);
    } finally {
      setSavingShortcut(false);
    }
  };

  const handleShortcutKeyEvent = useCallback(
    (event: ShortcutKeyEvent) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecording(false);
        setDraftShortcut(savedShortcut);
        setShortcutMessage('已取消录入。');
        return;
      }

      const { shortcut, error } = shortcutFromKeyboardEvent(event);
      if (error) {
        setShortcutMessage(error);
        return;
      }
      if (!shortcut) return;

      setDraftShortcut(shortcut);
      setRecording(false);
      setShortcutMessage('已录入，保存后生效。');
    },
    [recording, savedShortcut],
  );

  useEffect(() => {
    if (!recording) return undefined;
    const onKeyDown = (event: KeyboardEvent) => handleShortcutKeyEvent(event);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleShortcutKeyEvent, recording]);

  return (
    <div className="overlay">
      <div className="settings-modal modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div>
            <h2 id="settings-title">设置</h2>
            <p>管理 {APP_NAME} 的本地偏好。</p>
          </div>
          <button className="icon-button" aria-label="关闭设置" onClick={onClose}>
            <X />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置栏目">
            <button
              className={`settings-nav-item ${activeSection === 'general' ? 'selected' : ''}`}
              onClick={() => setActiveSection('general')}
            >
              <Settings size={18} />
              <span>通用</span>
            </button>
            <button
              className={`settings-nav-item ${activeSection === 'browser' ? 'selected' : ''}`}
              onClick={() => setActiveSection('browser')}
            >
              <Puzzle size={18} />
              <span>浏览器扩展</span>
            </button>
          </nav>

          {activeSection === 'general' ? (
          <section className="settings-panel" aria-label="通用设置">
            <section className="settings-panel-section" aria-labelledby="security-settings-title">
              <div className="settings-panel-heading">
                <h3 id="security-settings-title">安全</h3>
                <p>解锁状态下长时间无操作时自动锁定保险库。</p>
              </div>
              <div className="idle-lock-row">
                <label htmlFor="idle-lock-select">自动锁定</label>
                <select
                  id="idle-lock-select"
                  className="idle-lock-select"
                  value={idleLockMinutes}
                  onChange={(event) => {
                    const minutes = Number(event.target.value);
                    onIdleLockMinutesChange(minutes);
                    void api.setIdleLockMinutes(minutes).catch(() => {});
                  }}
                >
                  <option value={1}>1 分钟</option>
                  <option value={5}>5 分钟</option>
                  <option value={10}>10 分钟</option>
                  <option value={30}>30 分钟</option>
                  <option value={0}>从不</option>
                </select>
              </div>
            </section>

            <section className="settings-panel-section" aria-labelledby="shortcut-settings-title">
              <div className="settings-panel-heading">
                <h3 id="shortcut-settings-title">快捷键</h3>
                <p>快速唤醒迷你查询窗口，减少在登录页面和主窗口之间来回切换。</p>
              </div>

              <div className="shortcut-list">
                <div className="shortcut-row">
                  <div className="shortcut-copy">
                    <strong>打开迷你查询</strong>
                    <span>在任意应用前台唤醒迷你查询窗口。</span>
                  </div>
                  <div className="shortcut-editor">
                    <button
                      ref={recorderRef}
                      type="button"
                      className={`shortcut-recorder ${recording ? 'recording' : ''}`}
                      aria-label="录入打开迷你查询快捷键"
                      aria-pressed={recording}
                      onClick={beginRecording}
                    >
                      <span className="shortcut-keys" aria-label={`快捷键 ${draftShortcut.keys.join(' ')}`}>
                        {draftShortcut.keys.map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                      </span>
                      <span className="shortcut-recorder-text">{recording ? '按下组合键' : '修改'}</span>
                    </button>
                    <div className="shortcut-actions">
                      <button className="secondary-button" disabled={!shortcutChanged || savingShortcut} onClick={() => void saveShortcut()}>
                        {savingShortcut ? '保存中' : '保存'}
                      </button>
                      <button className="plain-button" disabled={savingShortcut} onClick={() => void resetShortcut()}>
                        恢复默认
                      </button>
                    </div>
                    {shortcutMessage && <span className="shortcut-message">{shortcutMessage}</span>}
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-panel-section" aria-labelledby="update-settings-title">
              <div className="settings-panel-heading">
                <h3 id="update-settings-title">版本与更新</h3>
                <p>{updateSummary}</p>
              </div>

              <div className={`update-card ${updateInfo?.available ? 'has-update' : ''}`}>
                <div className="update-copy">
                  <strong>{updateInfo?.available ? `新版本 ${updateInfo.latestVersion}` : 'GitHub 发布版本'}</strong>
                  <span>
                    {updateInfo
                      ? updateInfo.available
                        ? '可以前往 GitHub 下载最新安装包。'
                        : '没有发现可用更新。'
                      : '从 GitHub Releases 获取最新版本。'}
                  </span>
                </div>

                <div className="update-actions">
                  <button className="secondary-button" disabled={checkingUpdate || openingRelease} onClick={() => void checkForUpdate()}>
                    <RefreshCw size={14} className={checkingUpdate ? 'spin-icon' : ''} />
                    <span>{checkingUpdate ? '检查中' : '检查更新'}</span>
                  </button>
                  {updateInfo?.available && (
                    <button className="primary-button update-open-button" disabled={openingRelease} onClick={() => void openReleasePage()}>
                      <Share size={14} />
                      <span>{openingRelease ? '打开中' : '前往 GitHub'}</span>
                    </button>
                  )}
                  {updateMessage && <span className="update-message">{updateMessage}</span>}
                </div>
              </div>
            </section>
          </section>
          ) : (
            <BrowserBridgeSettings />
          )}
        </div>
      </div>
    </div>
  );
}

function BrowserBridgeSettings() {
  const [bridgeInfo, setBridgeInfo] = useState<BridgeInfo>();
  const [origins, setOrigins] = useState<string[]>([]);
  const [trustAll, setTrustAll] = useState(false);
  const [newOrigin, setNewOrigin] = useState('');
  const [extensionDir, setExtensionDir] = useState('');
  const [message, setMessage] = useState('');
  const [copiedToken, setCopiedToken] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getBridgeInfo()
      .then((info) => {
        if (!cancelled) setBridgeInfo(info);
      })
      .catch((err) => {
        if (!cancelled) setMessage(String(err));
      });
    api
      .listBridgeOrigins()
      .then((next) => {
        if (!cancelled) setOrigins(next);
      })
      .catch(() => {});
    api
      .getBridgeTrustAll()
      .then((enabled) => {
        if (!cancelled) setTrustAll(enabled);
      })
      .catch(() => {});
    api
      .getExtensionDir()
      .then((dir) => {
        if (!cancelled) setExtensionDir(dir);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const copyToken = async () => {
    if (!bridgeInfo) return;
    try {
      await writeClipboard(bridgeInfo.token);
    } catch (err) {
      console.warn('Copy failed', err);
      setMessage(`复制失败：${String(err)}`);
      return;
    }
    setCopiedToken(true);
    window.setTimeout(() => setCopiedToken(false), 1200);
  };

  const regenerate = async () => {
    setBusy(true);
    setMessage('');
    try {
      setBridgeInfo(await api.regenerateBridgeToken());
      setMessage('已生成新令牌，旧令牌立即失效，请在扩展弹窗中重新粘贴。');
    } catch (err) {
      setMessage(`操作失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (origin: string) => {
    setMessage('');
    try {
      setOrigins(await api.revokeBridgeOrigin(origin));
    } catch (err) {
      setMessage(`操作失败：${String(err)}`);
    }
  };

  const addOrigin = async () => {
    const value = newOrigin.trim();
    if (!value) return;
    setMessage('');
    try {
      setOrigins(await api.addBridgeOrigin(value));
      setNewOrigin('');
    } catch (err) {
      setMessage(`添加失败：${String(err)}`);
    }
  };

  const toggleTrustAll = async () => {
    setMessage('');
    try {
      setTrustAll(await api.setBridgeTrustAll(!trustAll));
    } catch (err) {
      setMessage(`操作失败：${String(err)}`);
    }
  };

  const openExtensionFolder = async () => {
    if (!extensionDir) return;
    setMessage('');
    try {
      await openPath(extensionDir);
    } catch (err) {
      setMessage(`打开失败：${String(err)}`);
    }
  };

  return (
    <section className="settings-panel" aria-label="浏览器扩展设置">
      <section className="settings-panel-section" aria-labelledby="bridge-token-title">
        <div className="settings-panel-heading">
          <h3 id="bridge-token-title">桌面桥接</h3>
          <p>
            {bridgeInfo
              ? `已启动，监听 127.0.0.1:${bridgeInfo.port}。扩展用下面的令牌与本机应用配对。`
              : '桥接服务启动中…'}
          </p>
        </div>
        <div className="bridge-token-row">
          <code className="bridge-token" title="桥接令牌">
            {bridgeInfo?.token || '————'}
          </code>
          <button className="secondary-button" disabled={!bridgeInfo} onClick={() => void copyToken()}>
            {copiedToken ? '已复制' : '复制令牌'}
          </button>
          <button className="plain-button" disabled={!bridgeInfo || busy} onClick={() => void regenerate()}>
            重新生成
          </button>
        </div>
        {message && <span className="shortcut-message">{message}</span>}
      </section>

      <section className="settings-panel-section" aria-labelledby="bridge-origins-title">
        <div className="settings-panel-heading">
          <h3 id="bridge-origins-title">已授权网站</h3>
          <p>这些网站可以请求自动填充保存的登录信息和 MFA 验证码。</p>
        </div>
        <div className="bridge-token-row">
          <input
            className="bridge-origin-input"
            value={newOrigin}
            placeholder="输入网站域名，例如 example.com"
            onChange={(event) => setNewOrigin(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void addOrigin()}
          />
          <button className="secondary-button" disabled={!newOrigin.trim()} onClick={() => void addOrigin()}>
            添加
          </button>
        </div>
        {origins.length === 0 ? (
          <p className="bridge-empty">还没有授权任何网站。也可以在浏览器中首次填充时按提示授权。</p>
        ) : (
          <div className="bridge-origin-list">
            {origins.map((origin) => (
              <div className="bridge-origin-row" key={origin}>
                <span>{origin}</span>
                <button className="plain-button" onClick={() => void revoke(origin)}>
                  撤销
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="bridge-trust-row">
          <div className="bridge-trust-copy">
            <strong>信任所有网站</strong>
            <span>开启后不再逐站弹窗确认（凭据仍按条目中的网站字段匹配，其他网站拿不到不匹配的凭据）。</span>
          </div>
          <button
            type="button"
            className={`switch ${trustAll ? 'on' : ''}`}
            aria-pressed={trustAll}
            aria-label="信任所有网站"
            onClick={() => void toggleTrustAll()}
          />
        </div>
      </section>

      <section className="settings-panel-section" aria-labelledby="bridge-install-title">
        <div className="settings-panel-heading">
          <h3 id="bridge-install-title">安装浏览器扩展</h3>
          <p>适用于 Chrome、Edge 等 Chromium 内核浏览器。</p>
        </div>
        <ol className="bridge-steps">
          <li>点击下方按钮，打开本机扩展文件夹。</li>
          <li>浏览器地址栏打开 <code>chrome://extensions</code>（Edge 为 <code>edge://extensions</code>）。</li>
          <li>打开「开发者模式」，点击「加载已解压的扩展程序」，选择扩展文件夹。</li>
          <li>点击工具栏中的起飞密码箱扩展图标，粘贴上方令牌完成连接。</li>
        </ol>
        <div className="bridge-install-actions">
          <button className="secondary-button" disabled={!extensionDir} onClick={() => void openExtensionFolder()}>
            打开扩展文件夹
          </button>
          {extensionDir && <span className="bridge-dir">{extensionDir}</span>}
        </div>
      </section>
    </section>
  );
}

function TypePickerModal({ onClose, onPick }: { onClose: () => void; onPick: (itemType: ItemType) => void }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleTypes = itemTypes.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
  const visibleMoreTypes = moreItemTypes.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
  const showMoreTypes = expanded || normalizedQuery.length > 0;

  return (
    <div className="overlay">
      <div className="type-picker modal-card">
        <button className="modal-close" onClick={onClose}>
          <X />
        </button>
        <h2>你想要添加什么？</h2>
        <label className="type-search">
          <Search />
          <input autoFocus value={query} placeholder="尝试搜索任意内容" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="type-grid">
          {visibleTypes.map((item) => (
            <button
              key={item.type}
              className={`type-card ${item.type === 'login' ? 'selected' : ''}`}
              disabled={!item.implemented}
              onClick={() => item.implemented && onPick(item.type)}
            >
              <span>{item.icon}</span>
              <strong>{item.label}</strong>
              {!item.implemented && <em>后续</em>}
            </button>
          ))}
        </div>
        {showMoreTypes && visibleMoreTypes.length > 0 && (
          <>
            <div className="more-type-divider" />
            <div className="more-type-grid">
              {visibleMoreTypes.map((item) => (
                <button key={item.label} className="more-type-card" disabled>
                  <span className="more-type-icon">{item.icon}</span>
                  <strong>{item.label}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        <button className="show-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '显示更少' : '显示更多'}
        </button>
      </div>
    </div>
  );
}

function ItemEditorModal({
  itemType,
  onClose,
  onSaveLogin,
  onSavePassword,
}: {
  itemType: ItemType;
  onClose: () => void;
  onSaveLogin: (input: LoginInput) => Promise<void>;
  onSavePassword: (input: PasswordInput) => Promise<void>;
}) {
  const typeConfig = itemTypes.find((item) => item.type === itemType) ?? itemTypes[0];
  const isPassword = itemType === 'password';
  const [loginInput, setLoginInput] = useState<LoginInput>(fallbackLogin);
  const [passwordInput, setPasswordInput] = useState<PasswordInput>(fallbackPassword);
  const [generatorHint, setGeneratorHint] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateLogin = (patch: Partial<LoginInput>) => setLoginInput((current) => ({ ...current, ...patch }));
  const updatePassword = (patch: Partial<PasswordInput>) => setPasswordInput((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      if (isPassword) {
        await onSavePassword(passwordInput);
      } else {
        await onSaveLogin(loginInput);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay">
      <div className="editor-modal modal-card" role="dialog" aria-modal="true" aria-labelledby="new-item-title">
        <header className="editor-header">
          <button className="icon-button" aria-label="返回" onClick={onClose}>
            <ArrowLeft />
          </button>
          <h2 id="new-item-title">新的项目</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className={`editor-body editor-details ${generatorOpen ? 'generator-open' : ''}`}>
          <div className="editor-elements">
            <EditorTitle
              itemType={itemType}
              icon={typeConfig.icon}
              value={isPassword ? passwordInput.title : loginInput.title}
              onChange={(title) => (isPassword ? updatePassword({ title }) : updateLogin({ title }))}
            />
            {isPassword ? (
              <PasswordEditorFields
                input={passwordInput}
                generatorHint={generatorHint}
                generatorOpen={generatorOpen}
                onGeneratorHintChange={setGeneratorHint}
                onGeneratorOpenChange={setGeneratorOpen}
                onChange={updatePassword}
              />
            ) : (
              <LoginEditorFields
                input={loginInput}
                generatorHint={generatorHint}
                generatorOpen={generatorOpen}
                onGeneratorHintChange={setGeneratorHint}
                onGeneratorOpenChange={setGeneratorOpen}
                onChange={updateLogin}
              />
            )}
          </div>
        </div>
        <footer className="editor-footer">
          <button className="primary-button save-button" disabled={saving} onClick={save}>
            {saving ? '保存中...' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function EditorTitle({
  itemType,
  icon,
  value,
  onChange,
}: {
  itemType: ItemType;
  icon: JSX.Element;
  value: string;
  onChange: (value: string) => void;
}) {
  const [customIconUrl, setCustomIconUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorIcon = itemType === 'login' ? <LockKeyhole /> : icon;

  useEffect(() => {
    return () => {
      if (customIconUrl) {
        URL.revokeObjectURL(customIconUrl);
      }
    };
  }, [customIconUrl]);

  return (
    <div className="editor-title-row">
      <div className="large-item-icon-wrap">
        <button
          type="button"
          className={`large-item-icon large-item-icon-${itemType}`}
          aria-label="选择新图标"
          onClick={() => fileInputRef.current?.click()}
        >
          <span className="large-item-icon-glyph">
            {customIconUrl ? <img className="large-item-custom-icon" src={customIconUrl} alt="" /> : editorIcon}
          </span>
        </button>
        <span className="large-item-icon-menu" aria-hidden="true">
          <ChevronDown size={19} />
        </span>
        <input
          ref={fileInputRef}
          className="icon-file-input"
          type="file"
          accept="image/*"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) {
              return;
            }
            setCustomIconUrl(URL.createObjectURL(file));
            event.currentTarget.value = '';
          }}
        />
      </div>
      <input
        autoFocus
        className="title-input"
        value={value}
        placeholder="输入标题"
        data-title-field
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function EditableFieldGroup({ children }: { children: ReactNode }) {
  return <div className="edit-group editable-field-group">{children}</div>;
}

function EditableTextField({
  label,
  labelValue,
  value,
  borderStyle = 'single',
  tone = 'primary',
  actions,
  inputClassName,
  placeholder,
  onLabelChange,
  onChange,
}: {
  label: string;
  labelValue?: string;
  value: string;
  borderStyle?: FieldBorderStyle;
  tone?: FieldTone;
  actions?: ReactNode;
  inputClassName?: string;
  placeholder?: string;
  onLabelChange?: (value: string) => void;
  onChange: (value: string) => void;
}) {
  const fieldId = useId();
  const currentLabel = labelValue ?? label;

  return (
    <div className={`editable-field ${tone} field-${borderStyle} ${actions ? 'with-actions' : ''}`}>
      <div className="editable-field-content">
        {onLabelChange ? (
          <input
            className="editable-field-label editable-field-label-input"
            value={currentLabel}
            aria-label={`${label}字段名称`}
            spellCheck={false}
            onChange={(event) => onLabelChange(event.target.value)}
          />
        ) : (
          <label className="editable-field-label" htmlFor={fieldId}>
            {label}
          </label>
        )}
        <div className="editable-field-value-container">
          <input
            id={fieldId}
            className={`editable-field-value ${inputClassName ?? ''}`}
            value={value}
            placeholder={placeholder}
            aria-label={onLabelChange ? `${currentLabel || label}值` : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      </div>
      {actions && <div className="editable-field-actions">{actions}</div>}
    </div>
  );
}

function LoginEditorFields({
  input,
  generatorHint,
  generatorOpen,
  onGeneratorHintChange,
  onGeneratorOpenChange,
  onChange,
}: {
  input: LoginInput;
  generatorHint: boolean;
  generatorOpen: boolean;
  onGeneratorHintChange: (value: boolean) => void;
  onGeneratorOpenChange: (value: boolean) => void;
  onChange: (patch: Partial<LoginInput>) => void;
}) {
  const [qrScanOpen, setQrScanOpen] = useState(false);

  return (
    <>
      <EditableFieldGroup>
        <EditableTextField
          label="用户名"
          value={input.username}
          borderStyle="top"
          onChange={(username) => onChange({ username })}
        />
        <EditablePasswordField
          value={input.password}
          borderStyle="bottom"
          generatorHint={generatorHint}
          generatorOpen={generatorOpen}
          onGeneratorHintChange={onGeneratorHintChange}
          onGeneratorOpenChange={onGeneratorOpenChange}
          onChange={(password) => onChange({ password })}
        />
      </EditableFieldGroup>
      <EditableFieldGroup>
        <EditableTextField
          label="MFA 密钥（TOTP）"
          value={input.totp_secret}
          borderStyle="single"
          tone="secondary"
          placeholder="粘贴 otpauth:// 链接或 Base32 密钥（可选）"
          onChange={(totp_secret) => onChange({ totp_secret })}
          actions={
            <button
              type="button"
              className="icon-button"
              aria-label="扫描二维码导入 MFA"
              title="扫描二维码：截图粘贴或选择图片"
              onClick={() => setQrScanOpen(true)}
            >
              <QrCode size={18} />
            </button>
          }
        />
      </EditableFieldGroup>
      {qrScanOpen && (
        <QrCodeImportModal
          onClose={() => setQrScanOpen(false)}
          onImport={(secret) => {
            onChange({ totp_secret: secret });
            setQrScanOpen(false);
          }}
        />
      )}
      <WebsiteFields input={input} onChange={onChange} />
      <EditorNotes value={input.notes} onChange={(notes) => onChange({ notes })} />
      <EditorTags tags={input.tags} onChange={(tags) => onChange({ tags })} />
    </>
  );
}

function decodeQrCodeFromImageFile(file: File | Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        URL.revokeObjectURL(sourceUrl);
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(sourceUrl);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      resolve(result?.data ?? null);
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      resolve(null);
    };
    image.src = sourceUrl;
  });
}

function QrCodeImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (secret: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [scanned, setScanned] = useState('');
  const [decoding, setDecoding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) =>
        entry.type.startsWith('image/'),
      );
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      await decodeFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const decodeFile = async (file: File | Blob) => {
    setDecoding(true);
    setMessage('');
    try {
      const text = await decodeQrCodeFromImageFile(file);
      if (!text) {
        setMessage('未在图片中识别到二维码，请换一张试试。');
        return;
      }
      const value = text.trim();
      const looksLikeOtpauth = value.toLowerCase().startsWith('otpauth://');
      const looksLikeBase32 = /^[A-Za-z2-7][A-Za-z2-9\s-]{15,}$/.test(value);
      if (!looksLikeOtpauth && !looksLikeBase32) {
        setMessage(`二维码内容不是 MFA 配置：${value.slice(0, 60)}`);
        return;
      }
      setScanned(value);
    } finally {
      setDecoding(false);
    }
  };

  const onDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) await decodeFile(file);
  };

  return (
    <div className="overlay">
      <div className="modal-card qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-scan-title">
        <header className="editor-header">
          <h2 id="qr-scan-title">扫描 MFA 二维码</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X />
          </button>
        </header>
        {scanned ? (
          <div className="qr-result">
            <p className="qr-result-label">已识别到 MFA 密钥：</p>
            <code className="qr-result-value">{scanned}</code>
            <div className="pairing-actions">
              <button className="secondary-button" onClick={() => setScanned('')}>
                重新扫描
              </button>
              <button className="primary-button" onClick={() => onImport(scanned)}>
                导入
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="qr-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void onDrop(event)}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => event.key === 'Enter' && fileInputRef.current?.click()}
            >
              <QrCode size={40} />
              <strong>点击选择二维码图片，或把图片拖到这里</strong>
              <span>
                网站显示两步验证二维码时：右键二维码「复制图片」，然后在本窗口按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴即可识别。
              </span>
            </div>
            <input
              ref={fileInputRef}
              className="icon-file-input"
              type="file"
              accept="image/*"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void decodeFile(file);
                event.currentTarget.value = '';
              }}
            />
            {decoding && <p className="qr-message">识别中...</p>}
            {message && <p className="qr-message">{message}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function WebsiteFields({
  input,
  onChange,
}: {
  input: LoginInput;
  onChange: (patch: Partial<LoginInput>) => void;
}) {
  const websites = websitesForLogin(input);
  const websiteLabels = websiteLabelsForLogin(input);
  const nextWebsiteRowId = useRef(0);
  const [rowIds, setRowIds] = useState<string[]>(() =>
    websites.map(() => `website-row-${nextWebsiteRowId.current++}`),
  );
  const sortableIds = useMemo(
    () => websites.map((_, index) => rowIds[index] ?? `website-row-fallback-${index}`),
    [rowIds, websites],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    setRowIds((current) => {
      if (current.length === websites.length) return current;
      if (current.length > websites.length) return current.slice(0, websites.length);
      return [
        ...current,
        ...Array.from({ length: websites.length - current.length }, () => `website-row-${nextWebsiteRowId.current++}`),
      ];
    });
  }, [websites.length]);

  const updateWebsite = (index: number, website: string) => {
    const nextWebsites = websites.map((currentWebsite, currentIndex) =>
      currentIndex === index ? website : currentWebsite,
    );
    onChange(websitePatch(nextWebsites, websiteLabels));
  };
  const updateWebsiteLabel = (index: number, label: string) => {
    const nextLabels = websiteLabels.map((currentLabel, currentIndex) =>
      currentIndex === index ? label : currentLabel,
    );
    onChange(websitePatch(websites, nextLabels));
  };
  const reorderWebsite = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setRowIds((current) => arrayMove(current, fromIndex, toIndex));
    onChange(websitePatch(arrayMove(websites, fromIndex, toIndex), arrayMove(websiteLabels, fromIndex, toIndex)));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const fromIndex = sortableIds.indexOf(String(active.id));
    const toIndex = sortableIds.indexOf(String(over.id));
    reorderWebsite(fromIndex, toIndex);
  };
  const addWebsite = () => {
    setRowIds((current) => [...current, `website-row-${nextWebsiteRowId.current++}`]);
    onChange(websitePatch([...websites, ''], [...websiteLabels, defaultWebsiteLabel]));
  };
  const removeWebsite = (index: number) => {
    if (websites.length === 1) {
      onChange(websitePatch([''], [defaultWebsiteLabel]));
      return;
    }
    setRowIds((current) => current.filter((_, currentIndex) => currentIndex !== index));
    onChange(
      websitePatch(
        websites.filter((_, currentIndex) => currentIndex !== index),
        websiteLabels.filter((_, currentIndex) => currentIndex !== index),
      ),
    );
  };

  return (
    <div className="website-field-group">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {websites.map((website, index) => (
            <WebsiteSortableRow
              key={sortableIds[index]}
              id={sortableIds[index]}
              disabled={websites.length < 2}
              index={index}
              label={websiteLabels[index] ?? defaultWebsiteLabel}
              value={website}
              onLabelChange={(nextLabel) => updateWebsiteLabel(index, nextLabel)}
              onChange={(nextWebsite) => updateWebsite(index, nextWebsite)}
              onRemove={() => removeWebsite(index)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button type="button" className="add-row" onClick={addWebsite}>
        <Plus />
        添加另一个网站
      </button>
    </div>
  );
}

function WebsiteSortableRow({
  id,
  disabled,
  index,
  label,
  value,
  onLabelChange,
  onChange,
  onRemove,
}: {
  id: UniqueIdentifier;
  disabled: boolean;
  index: number;
  label: string;
  value: string;
  onLabelChange: (value: string) => void;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`optional-field-row sortable-field-row ${isDragging ? 'is-dragging' : ''}`}
      style={style}
    >
      <button
        type="button"
        className={`drag-handle sort-button ${disabled ? 'is-disabled' : ''}`}
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={disabled ? undefined : `拖动网站字段 ${index + 1}`}
        aria-hidden={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
      >
        <GripVertical />
      </button>
      <EditableTextField
        label="网站"
        labelValue={label}
        value={value}
        borderStyle={index === 0 ? 'top' : 'middle'}
        tone="secondary"
        onLabelChange={onLabelChange}
        onChange={onChange}
        actions={
          <>
            <button type="button" className="icon-button" aria-label="网站字段选项">
              <SlidersHorizontal />
            </button>
            <button type="button" className="danger-icon" aria-label="移除网站字段" onClick={onRemove}>
              <MinusCircle />
            </button>
          </>
        }
      />
    </div>
  );
}

function PasswordEditorFields({
  input,
  generatorHint,
  generatorOpen,
  onGeneratorHintChange,
  onGeneratorOpenChange,
  onChange,
}: {
  input: PasswordInput;
  generatorHint: boolean;
  generatorOpen: boolean;
  onGeneratorHintChange: (value: boolean) => void;
  onGeneratorOpenChange: (value: boolean) => void;
  onChange: (patch: Partial<PasswordInput>) => void;
}) {
  return (
    <>
      <EditableFieldGroup>
        <EditablePasswordField
          value={input.password}
          borderStyle="single"
          generatorHint={generatorHint}
          generatorOpen={generatorOpen}
          onGeneratorHintChange={onGeneratorHintChange}
          onGeneratorOpenChange={onGeneratorOpenChange}
          onChange={(password) => onChange({ password })}
        />
      </EditableFieldGroup>
      <EditorNotes value={input.notes} onChange={(notes) => onChange({ notes })} />
      <EditorTags tags={input.tags} onChange={(tags) => onChange({ tags })} />
    </>
  );
}

function EditablePasswordField({
  value,
  borderStyle = 'single',
  generatorHint,
  generatorOpen,
  onGeneratorHintChange,
  onGeneratorOpenChange,
  onChange,
}: {
  value: string;
  borderStyle?: FieldBorderStyle;
  generatorHint: boolean;
  generatorOpen: boolean;
  onGeneratorHintChange: (value: boolean) => void;
  onGeneratorOpenChange: (value: boolean) => void;
  onChange: (password: string) => void;
}) {
  const fieldId = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  const showGeneratorHint = () => {
    if (!generatorOpen) {
      onGeneratorHintChange(true);
    }
  };

  useEffect(() => {
    if (!generatorHint || generatorOpen) {
      return undefined;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!fieldRef.current?.contains(event.target as Node)) {
        onGeneratorHintChange(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [generatorHint, generatorOpen, onGeneratorHintChange]);

  return (
    <>
      {generatorOpen && (
        <button
          type="button"
          className="password-generator-backdrop"
          aria-label="关闭密码生成器"
          onClick={() => onGeneratorOpenChange(false)}
        />
      )}
      <div
        ref={fieldRef}
        className={`editable-field primary field-${borderStyle} password-edit-field ${generatorOpen ? 'generator-open' : ''}`}
        onPointerDownCapture={showGeneratorHint}
      >
        <div className="editable-field-content">
          <label className="editable-field-label" htmlFor={fieldId}>
            密码
          </label>
          <div className="editable-field-value-container">
            <input
              id={fieldId}
              className="editable-field-value"
              type="password"
              value={value}
              spellCheck={false}
              onFocus={showGeneratorHint}
              onClick={showGeneratorHint}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
        </div>
        {generatorHint && !generatorOpen && (
          <button type="button" className="generate-chip" onClick={() => onGeneratorOpenChange(true)}>
            <KeyRound size={18} />
            创建新密码
          </button>
        )}
        {generatorOpen && (
          <PasswordGeneratorPopover
            onCancel={() => onGeneratorOpenChange(false)}
            onUse={(password) => {
              onChange(password);
              onGeneratorHintChange(false);
              onGeneratorOpenChange(false);
            }}
          />
        )}
      </div>
    </>
  );
}

function EditorNotes({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const fieldId = useId();

  return (
    <div className="notes-box editable-note-field">
      <label htmlFor={fieldId}>备注</label>
      <textarea
        id={fieldId}
        value={value}
        placeholder="在这里添加关于此项目的备注。"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function EditorTags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const addTag = () => {
    const nextTag = draft.trim();
    if (!nextTag) return;
    if (!tags.includes(nextTag)) {
      onChange([...tags, nextTag]);
    }
    setDraft('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((currentTag) => currentTag !== tag));
  };

  return (
    <div className="editor-tag-section">
      <span className="editor-section-label">标签</span>
      <div className="editor-tags">
        {tags.map((tag) => (
          <button key={tag} type="button" className="editable-tag" onClick={() => removeTag(tag)}>
            <span>{tag}</span>
            <X size={15} />
          </button>
        ))}
        <label className="tag-entry">
          <Plus size={19} />
          <input
            value={draft}
            placeholder="添加标签"
            onBlur={addTag}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addTag();
              }
              if (event.key === 'Backspace' && !draft && tags.length > 0) {
                onChange(tags.slice(0, -1));
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}

function PasswordGeneratorPopover({
  onCancel,
  onUse,
}: {
  onCancel: () => void;
  onUse: (password: string) => void;
}) {
  const [length, setLength] = useState(passwordLengthLimits.default);
  const [generatorType, setGeneratorType] = useState<PasswordGeneratorType>('random');
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [includeNumbers, setIncludeNumbers] = useState(true);
  const [includeSymbols, setIncludeSymbols] = useState(false);
  const [password, setPassword] = useState('');
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const selectedType = passwordGeneratorTypes.find((option) => option.value === generatorType) ?? passwordGeneratorTypes[0];
  const lengthProgress =
    ((length - passwordLengthLimits.min) / (passwordLengthLimits.max - passwordLengthLimits.min)) * 100;
  const setClampedLength = (nextLength: number) =>
    setLength(clamp(nextLength, passwordLengthLimits.min, passwordLengthLimits.max));

  const generateLocalPassword = useCallback(() => {
    const pick = <T,>(values: T[]) => {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      return values[bytes[0] % values.length];
    };

    if (generatorType === 'pin') {
      const digits = new Uint32Array(length);
      crypto.getRandomValues(digits);
      return Array.from(digits, (value) => String(value % 10)).join('');
    }

    const words: string[] = [];
    while (words.join('-').length < length) {
      words.push(pick(memorablePasswordWords));
    }
    return words.join('-').slice(0, length);
  }, [generatorType, length]);

  const refresh = useCallback(async () => {
    if (generatorType === 'random') {
      setPassword(
        await api.generatePassword({
          length,
          include_numbers: includeNumbers,
          include_symbols: includeSymbols,
        }),
      );
      return;
    }

    setPassword(generateLocalPassword());
  }, [generateLocalPassword, generatorType, includeNumbers, includeSymbols, length]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!typeMenuOpen) {
      return undefined;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!typeMenuRef.current?.contains(event.target as Node)) {
        setTypeMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
  }, [typeMenuOpen]);

  useEffect(() => {
    if (!password) return;
    passwordInputRef.current?.focus();
    passwordInputRef.current?.select();
  }, [password]);

  return (
    <div className="password-popover">
      <div className="generator-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="icon-button" aria-label="重新生成密码" onClick={refresh}>
          <RefreshCw size={22} />
        </button>
        <button type="button" className="primary-button" onClick={() => onUse(password)}>
          使用
        </button>
      </div>
      <input
        ref={passwordInputRef}
        className="generated-password"
        aria-label="生成的密码"
        spellCheck={false}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="strength-bar" />
      <div className="generator-row">
        <span>类型</span>
        <div className="generator-type-control" ref={typeMenuRef}>
          <button
            type="button"
            className="select-button"
            aria-haspopup="menu"
            aria-expanded={typeMenuOpen}
            onClick={() => setTypeMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setTypeMenuOpen(false);
              }
            }}
          >
            {selectedType.label}
            <ChevronDown size={16} />
          </button>
          {typeMenuOpen && (
            <div className="generator-type-menu" role="menu">
              {passwordGeneratorTypes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === generatorType}
                  className={option.value === generatorType ? 'selected' : ''}
                  onClick={() => {
                    setGeneratorType(option.value);
                    setTypeMenuOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === generatorType && <Check size={18} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="generator-row generator-row-slider">
        <span>字符</span>
        <div className="generator-slider-wrap" style={{ '--range-progress': `${lengthProgress}%` } as CSSProperties}>
          <input
            className="generator-slider"
            type="range"
            min={passwordLengthLimits.min}
            max={passwordLengthLimits.max}
            value={length}
            aria-label="密码字符数"
            onChange={(event) => setClampedLength(Number(event.target.value))}
          />
          <input
            className="length-value"
            type="number"
            min={passwordLengthLimits.min}
            max={passwordLengthLimits.max}
            value={length}
            aria-label="密码长度"
            onChange={(event) => setClampedLength(Number(event.target.value))}
          />
        </div>
      </div>
      <div className="generator-row">
        <span>数字</span>
        <button
          type="button"
          className={`switch ${includeNumbers ? 'on' : ''}`}
          aria-pressed={includeNumbers}
          aria-label="包含数字"
          onClick={() => setIncludeNumbers((value) => !value)}
        />
      </div>
      <div className="generator-row">
        <span>符号</span>
        <button
          type="button"
          className={`switch ${includeSymbols ? 'on' : ''}`}
          aria-pressed={includeSymbols}
          aria-label="包含符号"
          onClick={() => setIncludeSymbols((value) => !value)}
        />
      </div>
    </div>
  );
}
