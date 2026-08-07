<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="pi-cc-extensions：Pi 终端效率扩展套件">
</p>

<p align="center">
  <a href="https://pi.dev/packages?name=pi-cc-extensions"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-cc-extensions"><img alt="npm version" src="https://img.shields.io/npm/v/pi-cc-extensions?style=flat-square&color=66E3C4"></a>
  <a href="#兼容性"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
  <a href="./extensions"><img alt="TypeScript extensions" src="https://img.shields.io/badge/TypeScript-extensions-3178C6?style=flat-square"></a>
</p>

<p align="center">
  类 Claude Code TUI输出风格、固定编辑器、上下文检查，以及 Agent / Session 引用。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

---

## 界面预览

<table>
  <img width="100%" alt="demo_new" src="https://github.com/user-attachments/assets/d4f9bb51-a49a-4a34-aa60-006514d37b09" />
</table>

## 快速开始

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

安装后执行 `/reload`

## 功能


| 功能                 | 说明                                                                            | 入口        |
| ---------------------- | --------------------------------------------------------------------------------- | ------------- |
| Claude Code 风格输出 | 工具摘要、折叠展开、rich edit/write diff，以及`on` / `off` / `compact` 三种模式 | `/ccstyle`  |
| Fixed editor 交互    | 基于`@tifan/pi-fixed-editor`，支持动态开关、每刻度 5 行滚动、工具点击与回到底部 | `/ccstyle`  |
| 上下文检查           | 查看上下文占用，并预览 System prompt、Tools、Skills 和消息内容                  | `/context`  |
| Session 引用         | 搜索并注入历史 Session 或现有 SubAgent 的有效上下文                             | `@session:` |
| 主题                 | 随包提供内置 GitHub Dark Default、CC Dark 主题                                  | `/theme`    |

## 本地开发

```bash
npm test
npm run typecheck
pi -e .
```

修改扩展后执行 `/reload`。

## 兼容性

- Node.js `>=22.19.0`
- Pi `^0.84.0`（通过根目录 `package.json` 的 `pi.extensions` 和 `pi.themes` 加载）
- 0.80.x 及更早版本请使用本包的旧版本（peerDependencies 已收紧为 `^0.84.0`）
- `@tifan/pi-fixed-editor`、Pi 或 TUI 内部实现升级后若显示异常，先执行 `/reload`

### Fullscreen 模式与日落功能

- 官方 `--tui-mode fullscreen`（及 `/settings` 运行时切换）复用官方布局：插件在 `tui.mode === "fullscreen"` 时自动让位，不安装任何渲染层（工具样式、紧凑模式、工具分组、固定编辑器均跳过），fullscreen 完全由官方 TUI 提供。数据类功能（context、session 引用、自动补全等）不受影响。
- 与官方 fullscreen 重叠的能力已日落（冻结开发、仅维持可用）：固定编辑器布局、独立滚动 transcript 等不再二次实现。
- 已知边界：运行时从 regular 切换到 fullscreen 时，插件行级渲染 patch 随旧 TUI 实例自动失效，但组件级样式 patch 仍生效（不影响官方布局）；如需完全隔离，建议以 fullscreen 模式启动会话。
- Pi 0.84+ 的 TUI 引用是惰性 Proxy（`createInteractiveTuiReference`），通过它捕获 `doRender`/`render`/`handleInput` 会解析到包装自身形成无限递归。插件检测到惰性 Proxy 后跳过行级渲染 patch；`@tifan/pi-fixed-editor` 的 compositor 因同样原因在 0.84+ 下停用（Fixed editor 交互功能暂时不可用，渲染由官方管线接管）。
- `compact-thinking.json` 配置文件已日落（不再读取、不再兼容），compact-thinking 的配置统一由 `claude-code-style.json` 管控。

## 推荐搭配


| 扩展                                     | 用途                                             |
| ------------------------------------------ | -------------------------------------------------- |
| `npm:@tintinweb/pi-subagents`            | 并行 SubAgent、后台任务与工作树隔离              |
| `npm:@tintinweb/pi-tasks`                | Claude Code 风格任务跟踪与协调                   |
| `npm:pi-mcp-adapter`                     | 按需发现 MCP 工具，减少上下文占用                |
| `npm:@ff-labs/pi-fff`                    | 模糊文件与内容检索（fffind / ffgrep）            |
| `npm:pi-web-access`                      | 网页搜索、URL 抓取、GitHub 克隆、PDF/视频解析    |
| `npm:pi-theme-picker`                    | 主题搜索和实时预览                               |
| `npm:@narumitw/pi-usage`                 | 查看当前账号用量（Codex / Copilot / OpenRouter） |
| `git:github.com/DietrichGebert/ponytail` | 极简编码：强制最懒但有效的方案                   |

## 致谢

- Compact transcript 基于 [`avhagedorn/pi-compact-transcript`](https://github.com/avhagedorn/pi-compact-transcript) v0.6.2（MIT）。
- Fixed editor 由 [`@tifan/pi-fixed-editor`](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-fixed-editor) 提供（MIT）。
- Rich diff 改编自 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md)。
- 启动头基于 [`EnderLiquid/pi-startup-header`](https://github.com/EnderLiquid/pi-startup-header)（MIT）。
- 命令别名基于 [`xRyul/pi-aliases`](https://github.com/xRyul/pi-aliases)（MIT）。
