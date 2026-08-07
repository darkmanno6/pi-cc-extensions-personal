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
  Claude Code-style output, context inspection, and Agent / Session references.
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

---

## Preview

<table>
  <img width="100%" alt="demo_new" src="https://github.com/user-attachments/assets/d4f9bb51-a49a-4a34-aa60-006514d37b09" />
</table>

## Quick start

```bash
pi install npm:pi-cc-extensions
```

Run `/reload` after installation, then try:

```text
/ccstyle       # Configure output and rich diffs
/context       # Inspect context usage
@              # Complete Agents, Sessions, and files
```

## Features


| Feature                      | Description                                                                         | Entry point |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------- |
| Claude Code-style output     | Tool summaries, expand/collapse, rich edit/write diffs, and`on` / `off` modes       | `/ccstyle`  |
| Fullscreen mouse interaction | Tool card/group click-to-toggle,`[show more]` previews, and a back-to-bottom button | `/ccstyle`  |
| Context inspection           | Usage breakdown and previews for the system prompt, tools, skills, and messages     | `/context`  |
| Session references           | Search and inject effective context from previous Sessions or existing SubAgents    | `@session:` |
| Theme                        | Bundled CC Dark and CC Light themes                                            | `/theme`    |

## Configuration

`/ccstyle` behavior is configured through `~/.pi/agent/claude-code-style.json`:

```json
{
  "mode": "on",                            // on: Claude Code-style output; off: Pi native rendering
  "excludeRenderers": [],                  // exact tool names that keep their native renderer; Agent always keeps its dedicated renderer
  "diffViewMode": "auto",                  // diff layout: auto / split / unified
  "diffIndicatorMode": "bars",             // diff change indicators: bars / classic / none
  "diffSplitMinWidth": 120,                // min terminal width before auto layout uses side-by-side columns
  "diffCollapsedLines": 24,                // diff body lines shown when collapsed; beyond that shows the expand hint (Ctrl+O / click)
  "diffWordWrap": true,                    // whether long diff lines wrap (otherwise truncated)
  "expandedPreviewMaxLines": 40,           // max body lines for expanded output/diff
  "useSummaryTitlesAsThinkingTitle": true, // use the latest provider summary as the active thinking title
  "previewLines": 3,                       // thinking preview lines; 0 hides the preview body
  "animationIntervalMs": 90                // thinking title animation interval in ms
}
```

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

- Node.js `>=22.19.0`, Pi `^0.84.0` (loaded through `pi.extensions` and `pi.themes` in the root `package.json`)
- Fixed-editor features have been smoothly migrated to the official pipeline: in TUI fullscreen mode, all `/ccstyle` mouse interactions work as usual.
- Need the removed fixed-editor layout or `compact` one-line summary mode? Use version `0.8.46` or earlier
- Removed: the fixed-editor layout and the `compact` one-line summary mode (a new compact mode is planned for a future release). Old configs with `"mode": "compact"` automatically fall back to `on`, and the `/ccstyle` panel only offers `on` / `off`.

## Recommended companions


| Extension                                | Purpose                                                      |
| ------------------------------------------ | -------------------------------------------------------------- |
| `npm:@tintinweb/pi-subagents`            | Parallel SubAgents, background tasks, and worktree isolation |
| `npm:@tintinweb/pi-tasks`                | Claude Code-style task tracking and coordination             |
| `npm:pi-mcp-adapter`                     | On-demand MCP tool discovery with lower context usage        |
| `npm:@ff-labs/pi-fff`                    | FFF-powered fuzzy file and content search (fffind / ffgrep)  |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing  |
| `npm:pi-theme-picker`                    | Theme search and live preview                                |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter       |
| `git:github.com/DietrichGebert/ponytail` | Lazy-mode coding: forces the simplest working solution       |

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/tool-diff/ATTRIBUTION.md`](./extensions/tool-diff/ATTRIBUTION.md).
- Startup header based on [`EnderLiquid/pi-startup-header`](https://github.com/EnderLiquid/pi-startup-header) (MIT).
- Command aliases based on [`xRyul/pi-aliases`](https://github.com/xRyul/pi-aliases) (MIT).
