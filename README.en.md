<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="pi-cc-extensions: a productivity extension suite for Pi">
</p>

<p align="center">
  <a href="https://pi.dev/packages?name=pi-cc-extensions"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-cc-extensions"><img alt="npm version" src="https://img.shields.io/npm/v/pi-cc-extensions?style=flat-square&color=66E3C4"></a>
  <a href="#compatibility"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
  <a href="./extensions"><img alt="TypeScript extensions" src="https://img.shields.io/badge/TypeScript-extensions-3178C6?style=flat-square"></a>
</p>

<p align="center">
  Claude Code-style output, a fixed editor, context inspection, and Agent / Session references.
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

---

## Preview

<table>
  <img width="2788" height="1846" alt="demo_new" src="https://github.com/user-attachments/assets/d4f9bb51-a49a-4a34-aa60-006514d37b09" />
</table>

## Quick start

```bash
pi install npm:pi-cc-extensions
```

Run `/reload` after installation, then try:

```text
/ccstyle       # Configure output and fixed-editor interaction
/context       # Inspect context usage
@              # Complete Agents, Sessions, and files
```

## Features


| Feature                   | Description                                                                                      | Entry point         |
| --------------------------- | -------------------------------------------------------------------------------------------------- | --------------------- |
| Claude Code-style output | Tool summaries, expand/collapse, rich edit/write diffs, and `on` / `off` / `compact` modes | `/ccstyle` |
| Fixed-editor interaction | Powered by `@tifan/pi-fixed-editor`, with runtime toggling, five-row wheel scrolling, tool clicks, and back-to-bottom control | `/ccstyle` |
| Context inspection | Usage breakdown and previews for the system prompt, tools, skills, and messages | `/context` |
| Session references        | Search and inject effective context from previous Sessions or existing SubAgents                 | `@session:`         |
| Theme                     | Bundled GitHub Dark Default and CC Dark themes                                                              | `/theme`            |

### Output modes


| Mode      | Behavior                                                              |
| ----------- | ----------------------------------------------------------------------- |
| `on`      | Claude Code-style tool output with rich diffs for`edit` and `write`   |
| `off`     | Native Pi renderers                                                   |
| `compact` | One-line previews, merged repeated calls, duration, and run summaries |

```text
/ccstyle on
/ccstyle off
/ccstyle compact
/ccstyle status
```

Configuration is stored in `~/.pi/agent/claude-code-style.json`:

```json
{
  "mode": "on",
  "excludeRenderers": [],
  "fixedEditorFeatures": true
}
```

- `excludeRenderers` uses exact tool names. `Agent` always keeps its dedicated renderer.
- `fixedEditorFeatures: true` enables `@tifan/pi-fixed-editor` plus mouse scrolling, clicks, viewport mapping, and the back-to-bottom indicator.
- Set it to `false`, or toggle **Fixed editor** in `/ccstyle`, to restore Pi's native scrolling editor immediately. `Ctrl+End` remains available.
- Run `/reload` after editing the file manually.

### `@` references

- Enter `@session:` to reference a previous Session.
- Enter `@agent-name` to delegate to a custom Agent.
- Compatible with `@bacnh85/pi-fff` and `@tintinweb/pi-subagents`.
- Session context is deduplicated and size-limited before injection.

## Other installation methods

```bash
# GitHub
pi install git:github.com/minuque/pi-cc-extensions

# Local repository
pi install /absolute/path/to/pi-cc-extensions
```

## Local development

```bash
npm test
npm run typecheck
pi -e .
```

Run `/reload` after changing extensions.

## Compatibility

- Node.js `>=22.19.0`
- Pi `^0.84.0` (loaded through `pi.extensions` and `pi.themes` in the root `package.json`)
- For Pi 0.80.x and earlier, use an older release of this package (peerDependencies are now `^0.84.0`)
- If a Pi, TUI, or `@tifan/pi-fixed-editor` update causes display issues, try `/reload` first

### Fullscreen mode & sunset features

- Official `--tui-mode fullscreen` (and runtime switching via `/settings`) is reused as-is: when `tui.mode === "fullscreen"`, the extension stands down and installs no rendering layer (tool styling, compact mode, tool grouping, and the fixed editor are all skipped), leaving fullscreen entirely to the official TUI. Data features (context, session references, autocomplete, etc.) are unaffected.
- Capabilities that overlap with the official fullscreen TUI are sunset (frozen, kept working only): fixed-editor layout, independently scrollable transcript, etc. — no second implementation.
- Known boundary: when switching from regular to fullscreen at runtime, per-TUI rendering patches are automatically abandoned with the old TUI instance, but component-level style patches remain active (they do not affect the official layout); for full isolation, start the session in fullscreen mode.
- Pi 0.84+ wraps the TUI reference in a lazy Proxy (`createInteractiveTuiReference`): capturing `doRender`/`render`/`handleInput` through it resolves to the wrapper itself and recurses infinitely. The extension detects the lazy Proxy and skips line-level rendering patches; `@tifan/pi-fixed-editor`'s compositor is likewise disabled on 0.84+ (Fixed editor interactions are temporarily unavailable; rendering is handled by the official pipeline).
- The `compact-thinking.json` config file is sunset (no longer read or maintained); compact-thinking settings are managed exclusively by `claude-code-style.json`.

## Recommended companions

| Extension                              | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `npm:@tintinweb/pi-subagents`        | Parallel SubAgents, background tasks, and worktree isolation |
| `npm:@tintinweb/pi-tasks`            | Claude Code-style task tracking and coordination     |
| `npm:pi-mcp-adapter`                 | On-demand MCP tool discovery with lower context usage |
| `npm:@ff-labs/pi-fff`                | FFF-powered fuzzy file and content search (fffind / ffgrep) |
| `npm:pi-web-access`                  | Web search, URL fetching, GitHub cloning, PDF/video parsing |
| `npm:pi-theme-picker`                | Theme search and live preview                         |
| `npm:pi-token-speed`                 | Tokens-per-second measurement via sliding window      |
| `npm:@narumitw/pi-usage`             | Current-account usage for Codex / Copilot / OpenRouter |
| `git:github.com/DietrichGebert/ponytail` | Lazy-mode coding: forces the simplest working solution |

## Credits

- Compact transcript behavior is based on [`avhagedorn/pi-compact-transcript`](https://github.com/avhagedorn/pi-compact-transcript) v0.6.2 (MIT).
- Fixed-editor behavior is provided by [`@tifan/pi-fixed-editor`](https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-fixed-editor) (MIT).
- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md).
- Startup header based on [`EnderLiquid/pi-startup-header`](https://github.com/EnderLiquid/pi-startup-header) (MIT).
- Command aliases based on [`xRyul/pi-aliases`](https://github.com/xRyul/pi-aliases) (MIT).
