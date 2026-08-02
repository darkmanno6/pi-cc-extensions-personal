# 工具 Render 示例（ccstyle）

> 由真实 renderer 驱动生成（`node .tmp-tool-render-demo.ts`），示例已剥离 ANSI。
> 实际 TUI 中包含状态色、背景色和 hover 高亮；Braille loading 帧会随时间变化。
> 当前版本：ccstyle 0.8.31。renderer 变更后应重跑脚本并同步本文件。

## 1. 运行态 / 完成态 / 失败态

```text
 ⠋ Bash rg -n 'renderCall' extensions/ --type ts       ← 运行中：Braille 转轮
   ↳ Pending…                                           ← pending 与完成态同为 3 格缩进
 ✓ Bash rg -n 'renderCall' extensions/ --type ts       ← 完成
   ↳ 2 lines returned • click to show more
 ✗ Read missing.ts                                     ← 失败
   ↳ ENOENT: no such file…y, open 'missing.ts' • click to show more
```

## 2. read 参数详情

```text
 ✓ Read extensions/index.ts (offset=10, limit=50)      ← 灰色 detail
   ↳ 40 lines loaded • click to show more
```

## 3. 单工具展开（Input/Output 树）

```text
  ✓ Bash rg -n 'renderCall' extensions/
  ├ Input
  │ command: rg -n 'renderCall' extensions/
  └ Output
    extensions/claude-code-style.ts:2532: renderCall(args, theme,
    context) {
```

## 4. edit/write rich diff

```text
 ✓ Edit sample.ts
   ↳ diff • +2 • -1 • unified [━━━━━━━━]
 ──────────────────────────────────────────────
 @@ -1,3 +1,4 @@
    1 │ import { run } from "./runner";
 ▌  2 │ const threshold = 41;
 ▌  2 │ const threshold = 42;
    3 │ export default run;
 ──────────────────────────────────────────────
↳ created                                       ← write 新建
↳ overwritten                                   ← write 覆盖
```

长 diff 提示：

```text
… (29 more diff lines • click to show more)
```

- hover `click to show more` 时由 muted 切换为白色 text。
- 点击提示可展开工具；展开后仍受 `expandedPreviewMaxLines` 限制。

## 5. Task 系列

```text
 ✓ Task List task list
   ↳ 3 tasks • 1 in progress • 1 pending • 1 completed • click to show more
   #1 in_progress 重构 renderer                 ← 展开：状态色 #id + status + subject
   #2 pending 补充测试
   #3 completed 发布 0.8.29
 ✓ Task Create 重构 renderer
   ↳ Created task #1 重构 renderer
 ✓ Task Execute 1 (+2 tasks)
   ↳ Started Tasks #1, #2, #3
 ✓ Task Get 3  /  ✓ Task Output 1  /  ✓ Task Update 3  /  ✓ Task Stop 1
```

## 6. Agent 家族

```text
 ✓ Agent 探活 subagent
 ✓ Get Subagent Result 7d535698-4ad6-47a
 ✓ Steer Subagent 7d535698-4ad6-47a
 ✓ Agents 并行调研
```

## 7. 外部工具

```text
 ✓ Skill ponytail
 ✓ Ask User Question 使用哪种方案？
 ✓ Enter Plan Mode enable read-only planning
 ✓ Exit Plan Mode present plan
 ✓ Web Search pi coding agent extension
 ✓ Fetch Content https://example.com
```

## 8. MCP / 自定义工具

```text
 ✓ Github Search pi                              ← MCP 标签转为人类可读标题
 ✓ Custom Translate                              ← 驼峰转为空格标题
```

## 9. 工具组（tool-grouping）

### 收起：运行中

```text
 ● Multiple Tools: 3 running • read, bash, ffgrep • click to show more
 ├ ⠋ Read extensions/index.ts
 ├ ⠋ Bash npm test
 └ ⠋ Ffgrep extensions/
```

### 收起：完成/失败

```text
 ● Multiple Tools: 2 done • 1 failed • read, bash, ffgrep • click to show more
 ├ ✓ Read extensions/index.ts
 ├ ✓ Bash npm test
 └ ✗ Ffgrep extensions/
```

### 展开：完整背景卡片

```text
 ● Multiple Tools: 2 done • 1 failed • read, bash, ffgrep • click to show more
 ├ ✓ Read extensions/index.ts
 │ ├ Input
 │ │ path: extensions/index.ts
 │ └ Output
 │   40 lines loaded
 ├ ✓ Bash npm test
 │ ├ Input
 │ │ command: npm test
 │ └ Output
 │   pass 79/79
 └ ✗ Ffgrep extensions/
   ├ Input
   │ path: extensions/
   │ pattern: renderCall
   └ Output
     no match
```

ANSI 剥离后无法展示背景，实际 TUI 行为如下：

- 组头始终使用状态色圆点 `●`。
- 内部工具使用 `✓`、`✗` 或 Braille loading spinner。
- 展开区统一绘制完整状态背景，左右和底部各 1 格 padding，无顶部 padding。
- 外层树在收起/展开时位置不变；Input/Output 树线与上方状态图标对齐。
- 点击展开区任意行、任意列（含底部 padding）均可收起。
- 组末尾不再额外追加空白行。

## 10. Working footer

保留 Pi 原生 spinner，仅扩展文本：

```text
⠋ Working...
⠋ Working... (↓ 1,234 tokens · 12s)
```

- 流式阶段按文本字符数 `/ 4` 估算 token。
- provider 提供 `usage.output` 时优先使用真实值。
- 支持多文本块、`text_end`/`done`/`error` 校准和跨 turn 重置。
- turn 结束后立即恢复默认状态，不显示 `✻ Turn took ...`。

## 已知问题（跟踪）

- **ffgrep 摘要取 path 而非 pattern**：`Ffgrep extensions/`。当前 `preferred` 键顺序中 `path` 排在 `pattern` 前。
- **TaskExecute/TaskStop 前缀拼接**：renderer 固定添加 `Started`/`Stopped`，结果文本若自带动词可能重复。

## 复现

```bash
node .tmp-tool-render-demo.ts
```
