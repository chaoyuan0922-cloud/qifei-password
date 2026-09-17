# 起飞密码箱

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" alt="FlyPassword app icon">
</p>

<h3 align="center">FlyPassword</h3>

<p align="center">
  本地优先的桌面密码管理器。用主密码解锁本地保险库，管理登录信息、独立密码，并通过迷你查询窗口快速复制常用凭据。
</p>

<p align="center">
  <a href="https://github.com/chaoyuan0922-cloud/qifei-password/releases"><img src="https://img.shields.io/github/v/release/chaoyuan0922-cloud/qifei-password?include_prereleases&label=release" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-0A84FF" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20React-24C8DB" alt="Built with Tauri and React">
</p>

![主界面](docs/screenshots/main-detail.png)

## 设计目标

起飞密码箱不是云端密码服务，而是一个更轻、更直接的本地工具：

- **本地优先**：保险库数据保存在本机，使用主密码解锁后才在内存中展开密钥。
- **桌面原生体验**：基于 Tauri 构建，界面风格贴近 macOS 桌面应用。
- **快速复制**：不用在浏览器登录页和主窗口之间来回切换，可以用迷你查询窗口搜索并复制字段。
- **聚焦常用场景**：优先做好登录信息、独立密码、搜索、编辑、复制和密码生成。

## 功能特性

- 主密码解锁本地保险库。
- 登录信息管理：标题、用户名、密码、网站、备注、标签。
- **MFA 动态验证码（TOTP）**：为登录信息保存 Base32 密钥或 `otpauth://` 链接，详情页实时显示 6 位验证码与倒计时，一键复制。
- **浏览器自动填充**：配合官方浏览器扩展（Chrome / Edge），在网页登录时自动填充用户名、密码与 MFA 验证码。
- 独立密码项目管理。
- 项目列表、收藏、搜索、分类筛选。
- 一键复制用户名、密码、网站等字段。
- 编辑模式支持网站字段增删、备注、标签和图标调整。
- 内置密码生成器，支持长度、数字、符号等选项。
- 迷你查询窗口支持关键字搜索、置顶、字段点击复制。

## 浏览器自动填充与 MFA

起飞密码箱通过本地桥接服务 + 浏览器扩展实现网页自动填充，全程数据不出本机：

```
浏览器扩展 ──(127.0.0.1 + 配对令牌)──> 起飞密码箱桌面应用 ──> 本地加密保险库
```

### 安装步骤

1. 打开应用「设置 → 浏览器扩展」，复制**桥接令牌**，点击**打开扩展文件夹**。
2. 浏览器进入 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择上一步打开的扩展文件夹。
4. 点击工具栏中的起飞密码箱扩展图标，粘贴桥接令牌完成连接。

### 使用方式

- 在网页登录页点击用户名或密码输入框，会浮出匹配的凭据列表，点击即可同时填充用户名和密码。
- 若条目保存了 MFA 密钥，登录后的验证码输入框会显示「填充 MFA 验证码」选项，一键填入当前有效的 6 位验证码。
- 首次在某个网站填充时会弹出授权确认，可随时在「设置 → 浏览器扩展 → 已授权网站」中撤销。
- 保险库锁定时扩展无法读取任何数据；「重新生成令牌」可立即让旧令牌失效。

### 安全说明

- 桥接服务仅监听 `127.0.0.1`，且要求 Bearer 令牌；令牌保存在本机用户数据目录。
- 每个网站都需要单独授权（按域名匹配，支持子域名），未授权的网站拿不到任何凭据。
- 数据仅在保险库解锁期间可用，锁定后 `/logins` 接口只返回 `locked` 状态。

## 技术栈

- **Desktop shell**：Tauri 2
- **Frontend**：React 18、TypeScript、Vite
- **UI**：CSS Modules-style plain CSS、Lucide icons、Inter 字体
- **Backend**：Rust、Tauri commands
- **Storage**：SQLite、`rusqlite`
- **Encryption**：Argon2id 密钥派生、XChaCha20-Poly1305 加密、`zeroize` 清理内存密钥
- **Desktop integration**：系统剪贴板、全局快捷键、macOS overlay title bar
- **Automation**：GitHub Actions 多平台 CI / Release 构建

## 界面预览

### 首次创建与主界面

#### 创建本地保险库

![创建本地保险库](docs/screenshots/setup.png)

#### 登录信息详情

![登录信息详情](docs/screenshots/main-detail.png)

### 编辑与创建

#### 编辑登录信息

![编辑登录信息](docs/screenshots/edit-item.png)

#### 密码生成器

![密码生成器](docs/screenshots/password-generator.png)

#### 新建项目

![新建项目类型选择](docs/screenshots/new-item.png)

### 迷你查询窗口

#### 空状态

![迷你查询空状态](docs/screenshots/quick-search-empty.png)

#### 搜索结果

![迷你查询搜索结果](docs/screenshots/quick-search-results.png)

#### 选中后复制字段

![迷你查询字段复制](docs/screenshots/quick-search-detail.png)

## 当前状态

当前版本优先支持两类项目：

- 登录信息
- 密码

新建入口中出现的安全备注、信用卡、身份标识、文档等类型属于后续扩展方向，界面已预留入口，但还不是当前版本的核心能力。

## 名称与包信息

- 中文产品名：`起飞密码箱`
- 英文产品名：`FlyPassword`
- GitHub 仓库名：`qifei-password`
- npm package / Rust crate：`fly-password`
- Bundle identifier：`ai.heihuzi.flypassword`

Tauri 的 `productName` 保持 ASCII，是为了让 GitHub Release 产物在 macOS、Windows 上拥有稳定的文件名；用户看到的窗口标题仍然是 `起飞密码箱`。

## 安全说明

起飞密码箱采用本地优先设计，保险库数据保存在用户设备上，不依赖云端同步服务。主密码用于解锁本地保险库，敏感字段会以加密形式存储。

当前版本仍处于早期阶段，尚未经过第三方安全审计。正式保存高价值凭据前，建议先完成更多跨平台测试、备份策略、签名发布和安全审计。后续可以通过独立的 `SECURITY.md` 公开更完整的威胁模型、数据格式和安全设计。

## 开发

安装依赖：

```bash
npm ci
```

启动桌面开发版：

```bash
npm run tauri dev
```

前端构建：

```bash
npm run build
```

Rust 后端检查：

```bash
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

本地打包：

```bash
npm run tauri -- build
```
