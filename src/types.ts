export type VaultStatus = 'no_vault' | 'locked' | 'unlocked';

export type VaultProfile = {
  name: string;
  avatar: string;
};

export type ItemType = 'login' | 'secure_note' | 'credit_card' | 'identity' | 'password' | 'document';

export type ItemOverview = {
  id: string;
  item_type: ItemType;
  title: string;
  subtitle: string;
  website?: string;
  icon_text: string;
  favorite: boolean;
  updated_at: string;
};

export type LoginItem = {
  id: string;
  item_type: 'login';
  title: string;
  username: string;
  password: string;
  website: string;
  websites?: string[];
  website_labels?: string[];
  totp_secret: string;
  notes: string;
  tags: string[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
};

export type PasswordItem = {
  id: string;
  item_type: 'password';
  title: string;
  password: string;
  notes: string;
  tags: string[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
};

export type VaultItem = LoginItem | PasswordItem;

export type LoginInput = {
  title: string;
  username: string;
  password: string;
  website: string;
  websites: string[];
  website_labels: string[];
  totp_secret: string;
  notes: string;
  tags: string[];
};

export type PasswordInput = {
  title: string;
  password: string;
  notes: string;
  tags: string[];
};

export type EditableItemInput =
  | { item_type: 'login'; input: LoginInput }
  | { item_type: 'password'; input: PasswordInput };

export type GeneratedPasswordOptions = {
  length: number;
  include_numbers: boolean;
  include_symbols: boolean;
};

export type QuickAccessShortcut = {
  accelerator: string;
  keys: string[];
};

export type TotpCode = {
  code: string;
  remaining_seconds: number;
  period_seconds: number;
};

export type BridgeInfo = {
  port: number;
  token: string;
};

export type AppUpdateInfo = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseName: string;
  releaseUrl: string;
  notes: string;
  publishedAt: string;
  checkedAt: string;
};
