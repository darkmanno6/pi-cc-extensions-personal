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
  类 Claude Code TUI 输出风格、上下文检查，以及 Agent / Session 引用。
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


| 功能                 | 说明                                                                                                     | 入口        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ------------- |
| Claude Code 风格输出 | 工具摘要、折叠展开、rich edit/write diff，以及`on` / `compact` / `off` 三种模式                          | `/ccstyle`  |
| Fullscreen 鼠标交互  | 工具卡/group 点击展开与收起、预览、hover 高亮、回到底部按钮 | `TUIMODE=fullscreen` 或 `--tui-mode fullscreen` |
| 配置面板             | `Style / Diff / Thinking / Feature` 四页签，含启动头开关与滚轮步进                                       | `/ccstyle`  |
| 上下文检查           | 查看上下文占用，并预览 System prompt、Tools、Skills 和消息内容                                           | `/context`  |
| Session 引用         | 搜索并注入历史 Session 或现有 SubAgent 的有效上下文                                                      | `@session:` |
| 主题                 | 随包提供内置 CC Dark、CC Light 主题                                                                      | `/theme`    |

## 配置

`/ccstyle` 的行为由 `~/.pi/agent/claude-code-style.json` 配置：

```js
{
  "mode": "on",                            // on：Claude Code 风格；compact：单行摘要；off：Pi 原生渲染
  "excludeRenderers": [],                  // 走原生渲染的工具名列表（精确匹配），Agent 始终保留专用渲染器
  "diffViewMode": "auto",                  // diff 布局：auto / split / unified
  "diffIndicatorMode": "bars",             // diff 变更指示：bars / classic / none
  "diffSplitMinWidth": 120,                // 自动布局下使用左右分栏的最小终端宽度
  "diffCollapsedLines": 24,                // 折叠时展示的 diff 行数，超出显示展开提示（Ctrl+O / 点击）
  "diffWordWrap": true,                    // 长 diff 行是否换行（否则截断）
  "expandedPreviewMaxLines": 40,           // 展开后输出/diff 正文的最大行数
  "useSummaryTitlesAsThinkingTitle": true, // 用最新 provider 摘要作为思考标题
  "previewLines": 3,                       // thinking 预览行数，0 隐藏预览正文
  "animationIntervalMs": 90,               // thinking 标题动画间隔（毫秒）
  "showStartupHeader": true,               // 自定义启动头（logo + tips）开关
  "scrollStepLines": 3                     // fullscreen 滚轮滚动步进行数
}
```

## 本地开发

```bash
npm test
npm run typecheck
./test.bat # or pi -e .
```

修改扩展后执行 `/reload`。

## 兼容性

- Node.js `>=22.19.0`，Pi `^0.84.0`（通过根目录 `package.json` 的 `pi.extensions` 和 `pi.themes` 加载）

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

- Rich diff 改编自 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md)。
