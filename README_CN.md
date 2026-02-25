# OpenClaw Desktop

[OpenClaw](https://github.com/openclaw/openclaw) 一键桌面启动器 — 你的私人 AI 助手。

无需命令行，一键下载、配置、运行 OpenClaw。

[English](README.md) | 中文

## 功能特性

- **一键安装** — 自动下载、安装依赖、编译、启动 OpenClaw，全程可视化进度
- **自动更新检测** — 启动时检查 GitHub 最新版本，提示是否更新
- **API Key 管理** — 可视化配置 OpenAI、Anthropic、Google、DeepSeek、xAI、豆包 等 12 个提供商的密钥
- **模型选择** — 在 GPT-5.1、Claude Opus 4.6、Gemini 3、Grok 4、DeepSeek R1 等模型间自由切换
- **频道配置** — 设置 WhatsApp、Telegram、Discord、Slack、飞书 等消息频道
- **Gateway 管理** — 通过系统托盘启动、停止、监控 OpenClaw 网关
- **自定义安装路径** — 选择 OpenClaw 的下载和安装位置
- **跨平台** — 支持 macOS (DMG)、Windows (NSIS)、Linux (AppImage/deb)
- **深色模式** — 自动跟随系统主题

## 截图

### 安装向导

<p align="center">
  <img src="assets/screenshot-setup.png" width="600" alt="安装向导">
</p>

### 控制面板（含顶部工具栏）

<p align="center">
  <img src="assets/screenshot-control.png" width="800" alt="控制面板">
</p>

## 环境要求

所有依赖会在点击 "Start Setup" 时**自动安装**，无需手动配置。

| 平台 | Git | Node.js 22 | pnpm |
|------|-----|-----------|------|
| **macOS** | Homebrew / xcode-select | Homebrew / nvm | npm / corepack |
| **Windows** | winget / choco | winget / choco / MSI | npm / standalone |
| **Linux** | apt / dnf / pacman | apt / dnf / nvm | npm / corepack |

<details>
<summary>手动安装（自动安装失败时）</summary>

- **macOS**: `brew install git node@22 && npm install -g pnpm`
- **Windows**: `winget install Git.Git OpenJS.NodeJS` 然后 `npm install -g pnpm`
- **Linux**: `sudo apt install git nodejs npm && npm install -g pnpm`（或用 [nvm](https://github.com/nvm-sh/nvm)）
</details>

## 普通用户

从 [Releases](https://github.com/your-username/openclaw-desktop/releases) 下载 DMG，打开后将 `OpenClaw Desktop.app` 拖入 Applications。首次启动时自动安装所有依赖（Node.js、Git、pnpm）。

## 开发者

> 从源码构建需要预装 Node.js >= 18。[下载 Node.js](https://nodejs.org/)

```bash
git clone https://github.com/your-username/openclaw-desktop.git
cd openclaw-desktop
npm install
npm run dev
```

## 开发

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 开发模式运行
npm run dev

# 运行编译后的应用
npm start
```

## 打包发布

为你的平台构建安装包：

```bash
# macOS DMG
npm run dist:mac

# Windows 安装程序
npm run dist:win

# Linux AppImage + deb
npm run dist:linux

# 所有平台
npm run dist
```

产出文件在 `release/` 目录。

## 项目结构

```
openclaw-desktop/
├── src/
│   ├── main.ts              # Electron 主进程 — 窗口、托盘、菜单、IPC
│   ├── preload.ts            # 安全 IPC 桥接（contextIsolation）
│   ├── openclaw-manager.ts   # 核心逻辑 — 下载、构建、Gateway 生命周期
│   ├── setup.html            # 安装向导 UI（带进度跟踪）
│   ├── settings.html         # API Key 与模型配置 UI
│   └── channels.html         # 消息频道配置 UI
├── assets/                   # 应用图标（SVG + PNG）
├── package.json              # 依赖与 electron-builder 打包配置
└── tsconfig.json             # TypeScript 配置
```

### 工作原理

```
┌─────────────────────────────────────────────┐
│            OpenClaw Desktop                 │
│                                             │
│  1. 检查环境（Node、Git、pnpm）              │
│  2. git clone openclaw/openclaw             │
│  3. pnpm install 安装依赖                    │
│  4. pnpm build + pnpm ui:build 编译         │
│  5. 启动 Gateway（node openclaw.mjs）        │
│  6. 自动注入认证 Token 到 Control UI         │
│  7. 在 Electron 窗口中加载 Control UI        │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  [API Keys]  [Model]  [Channels]      │  │
│  ├───────────────────────────────────────┤  │
│  │                                       │  │
│  │        OpenClaw 控制面板               │  │
│  │    （聊天、频道、代理、技能...）         │  │
│  │                                       │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 支持的 AI 提供商

| 提供商 | 环境变量 | 模型 |
|--------|---------|------|
| OpenAI | `OPENAI_API_KEY` | GPT-5.1 Codex、GPT-4.1、o3、o4-mini |
| Anthropic | `ANTHROPIC_API_KEY` | Claude Opus 4.6、Sonnet 4.6、Haiku 3.5 |
| Google | `GEMINI_API_KEY` | Gemini 3 Pro、2.5 Pro/Flash |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek R1、Chat |
| xAI | `XAI_API_KEY` | Grok 4、Grok 3 |
| 火山引擎（豆包） | `VOLCANO_ENGINE_API_KEY` | Doubao Pro/Lite |
| Groq | `GROQ_API_KEY` | Llama 3.3 70B |
| Mistral | `MISTRAL_API_KEY` | Mistral Large |
| OpenRouter | `OPENROUTER_API_KEY` | Auto（任意模型） |
| 千帆（百度） | `QIANFAN_API_KEY` | DeepSeek V3.2、文心 5.0 |
| Moonshot（Kimi） | `MOONSHOT_API_KEY` | Kimi K2.5 |
| NVIDIA | `NVIDIA_API_KEY` | Nemotron 70B |

### 支持的消息频道

WhatsApp、Telegram、Discord、Slack、飞书/Lark、Signal、Google Chat、Microsoft Teams、Matrix、WebChat

## 配置文件

所有配置存储在 `~/.openclaw/` 目录：

| 文件 | 用途 |
|------|------|
| `openclaw.json` | 主配置（模型、频道、Gateway 认证） |
| `.env` | AI 提供商的 API 密钥 |

桌面应用通过 Settings 和 Channels 页面读写这些文件。

## 许可证

[MIT](LICENSE)

## 致谢

基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建 — 开源的个人 AI 助手。
