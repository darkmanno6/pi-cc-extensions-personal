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
  Claude Code 风格界面、结构化问卷、上下文检查，以及 Agent / Session 引用。
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
      <br>
      <sub><b>欢迎界面</b><br> @ <code>npm:pi-startup-header</code> 与 <code>npm:pi-zentui</code></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="./assets/readme/fixed-editor-navigation.webp" width="100%" alt="Pi fixed-editor 中的工具结果、回到底部按钮与 Ctrl+End 快捷键">
      <br>
      <sub><b>固定编辑器工作流</b><br>工具结果摘要、折叠展开与键盘导航</sub>
    </td>
    <td width="50%" align="center">
      <img src="./assets/readme/session-reference.webp" width="100%" alt="在 Pi 中通过 @ 补全选择历史 Session">
      <br>
      <sub><b>历史 Session 引用</b><br>通过 @ 补全快速找到并引用历史会话</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="./assets/readme/context-usage.webp" width="100%" alt="Pi 上下文窗口用量查看器">
      <br>
      <sub><b>上下文用量</b><br>查看 System prompt、Tools、Skills 等占用分布</sub>
    </td>
    <td width="50%" align="center">
      <img src="./assets/readme/context-preview.webp" width="100%" alt="Pi 中展开查看 System Prompt 内容">
      <br>
      <sub><b>上下文预览</b><br>按类别展开查看实际注入的上下文内容</sub>
    </td>
  </tr>
</table>

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
| Claude Code 风格输出         | 工具摘要、折叠展开、rich edit/write diff，以及`on` / `off` / `compact` 三种模式 | `/ccstyle`          |
| Fixed editor 交互            | 每刻度 5 行滚动、工具点击、收起位置补偿、回到底部按钮与`Ctrl+End`               | `/ccstyle`          |
| Ask User Question 结构化问卷 | 单选、多选、自定义回答、Markdown 预览及 RPC / ACP 降级                          | `ask_user_question` |
| 上下文检查                   | 查看上下文占用，并预览 System prompt、Tools、Skills 和消息内容                  | `/context`          |
| Session 引用                 | 搜索并注入历史 Session 或现有 SubAgent 的有效上下文                             | `@session:`         |
| 主题                         | 随包提供内置 GitHub Dark Default 主题                                           | `/theme`            |

## 本地开发

```bash
npm test
npm run typecheck
pi -e .
```

修改扩展后执行 `/reload`。修改 `extensions/ask-user-question/` 或重装其依赖后，需要完整重启 Pi。

## 兼容性

- Node.js `>=22.19.0`
- 通过根目录 `package.json` 的 `pi.extensions` 和 `pi.themes` 加载
- `pi-zentui`、Pi 或 TUI 内部实现升级后若显示异常，先执行 `/reload`

## 推荐搭配


| 扩展                          | 用途                                |
| ------------------------------- | ------------------------------------- |
| `npm:pi-zentui`               | Fixed editor、状态栏和 Git 状态     |
| `npm:@tintinweb/pi-subagents` | 并行 SubAgent、后台任务与工作树隔离 |
| `npm:pi-mcp-adapter`          | 按需发现 MCP 工具，减少上下文占用   |
| `npm:pi-theme-picker`         | 主题搜索和实时预览                  |
| `npm:@ayulab/pi-rewind`       | 基于 checkpoint 回退代码或对话      |
| `npm:pi-compact-thinking`     | 紧凑显示隐藏的 thinking 块          |

## 致谢

- Compact transcript 基于 [`avhagedorn/pi-compact-transcript`](https://github.com/avhagedorn/pi-compact-transcript) v0.6.2（MIT）。
- 结构化问卷基于 [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) v2.1.0（MIT）。
- Rich diff 改编自 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md)。
- 启动头基于 [`EnderLiquid/pi-startup-header`](https://github.com/EnderLiquid/pi-startup-header)（MIT）。
- 命令别名基于 [`xRyul/pi-aliases`](https://github.com/xRyul/pi-aliases)（MIT）。
