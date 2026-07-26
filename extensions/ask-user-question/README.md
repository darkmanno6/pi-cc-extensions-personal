# ask_user_question

English-only structured questionnaire bundled with `pi-cc-extensions`.

## Features

- One to four questions per call.
- Two to four authored options per question.
- Single-select and multi-select modes.
- Automatically appended `Type something.` custom-answer row.
- Optional notes and Markdown previews.
- Submit review for multi-question calls.
- RPC/ACP fallback through native select/input dialogs.
- Removed from the model's tool list when no UI is available.

## Editor compatibility

The TUI uses Pi's native temporary editor flow and does not replace the configured editor factory.

- Pi's default scrolling editor is restored with its draft and focus after the questionnaire closes.
- Fixed-editor compositors remain active.
- On terminals with at least 16 rows, the questionnaire preserves at least six transcript rows and about 30% of terminal height.
- On smaller terminals, the questionnaire may use the full height to remain usable.

## Keyboard

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move between options |
| `Enter` | Confirm or activate the selected row |
| `Space` | Toggle a multi-select option |
| `Tab` / `Shift+Tab` | Switch question tabs |
| `n` | Open notes |
| `Ctrl+]` | Collapse or expand the questionnaire |
| `Esc` | Cancel |

## Configuration

Optional file: `~/.config/rpiv-ask-user-question/config.json`

```json
{
  "collapseKey": "alt+o",
  "guidance": {
    "promptSnippet": "Ask before guessing on ambiguous requirements",
    "promptGuidelines": [
      "Batch related questions into one ask_user_question call."
    ]
  }
}
```

Set `collapseKey` to `"off"` to disable collapsing. UI text is intentionally English-only; no localization package or locale files are loaded.

## Development

The TUI module graph is cached for the process lifetime. After changing this extension or reinstalling dependencies, fully restart Pi instead of relying only on `/reload`.

## Attribution

Based on `@juicesharp/rpiv-ask-user-question` v2.1.0 with local editor-layout and transcript-viewport compatibility changes.

MIT — see [LICENSE](./LICENSE).
