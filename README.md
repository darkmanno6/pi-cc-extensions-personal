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
  类 Claude Code 风格界面、固定编辑器、上下文检查，以及 Agent / Session 引用。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>





---

## 界面预览

<table>
  <tr>
    <td colspan="2" align="center">
      <img src="./assets/readme/welcome.webp" width="100%" alt="Pi 启动后的欢迎界面">
    </td>
  </tr>
</table>

https://github.com/user-attachments/assets/4ae094d2-7480-484b-a0c8-6e782495ce9f

## 快速开始

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

安装后执行 `/reload`

## 功能


| 功能                         | 说明                                                                            | 入口                |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------- |
| Claude Code 风格输出 | 工具摘要、折叠展开、rich edit/write diff，以及`on` / `off` / `compact` 三种模式 | `/ccstyle` |
| Fixed editor 交互 | 基于 `@tifan/pi-fixed-editor`，支持动态开关、每刻度 5 行滚动、工具点击与回到底部 | `/ccstyle` |
| 上下文检查 | 查看上下文占用，并预览 System prompt、Tools、Skills 和消息内容 | `/context` |
| Session 引用                 | 搜索并注入历史 Session 或现有 SubAgent 的有效上下文                             | `@session:`         |
| 主题                         | 随包提供内置 GitHub Dark Default 主题                                           | `/theme`            |

## 本地开发

```bash
npm test
npm run typecheck
pi -e .
```

修改扩展后执行 `/reload`。

## 兼容性

- Node.js `>=22.19.0`
- 通过根目录 `package.json` 的 `pi.extensions` 和 `pi.themes` 加载
- `@tifan/pi-fixed-editor`、Pi 或 TUI 内部实现升级后若显示异常，先执行 `/reload`

## 推荐搭配


| 扩展                          | 用途                                |
| ------------------------------- | ------------------------------------- |
| `npm:@tintinweb/pi-subagents` | 并行 SubAgent、后台任务与工作树隔离 |
| `npm:pi-mcp-adapter`          | 按需发现 MCP 工具，减少上下文占用   |
| `npm:pi-theme-picker`         | 主题搜索和实时预览                  |
| `npm:@ayulab/pi-rewind`       | 基于 checkpoint 回退代码或对话      |
| `npm:pi-compact-thinking`     | 紧凑显示隐藏的 thinking 块          |

## 致谢

- Compact transcript 基于 [`avhagedorn/pi-compact-transcript`](https://github.com/avhagedorn/pi-compact-transcript) v0.6.2（MIT）。
- Fixed editor 由 [`@tifan/pi-fixed-editor`](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-fixed-editor) 提供（MIT）。
- Rich diff 改编自 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md)。
- 启动头基于 [`EnderLiquid/pi-startup-header`](https://github.com/EnderLiquid/pi-startup-header)（MIT）。
- 命令别名基于 [`xRyul/pi-aliases`](https://github.com/xRyul/pi-aliases)（MIT）。
