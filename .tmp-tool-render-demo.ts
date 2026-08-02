// Temporary demo: renders every tool type through the real ccstyle renderer.
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import {
	renderRichToolResult,
	WriteExecutionMetadataStore,
} from "./extensions/tool-diff/index.ts";
import { installToolGrouping } from "./extensions/tool-grouping.ts";
import claudeCodeStyleExtension from "./extensions/claude-code-style.ts";

initTheme("dark");
const ui = {
	theme: { fg: (_color: string, text: string) => text },
	setStatus() {},
	requestRender() {},
} as any;
const strip = (lines: string[]) =>
	lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));

const events = new Map<string, Function>();
const pi = {
	registerTool() {},
	registerCommand() {},
	registerShortcut() {},
	on(name: string, handler: Function) {
		events.set(name, handler);
	},
};
claudeCodeStyleExtension(pi as any, { mode: "on" });
await events.get("session_start")?.({}, { mode: "print", hasUI: false, ui });

const WIDTH = 84;
function tool(name: string, args: any = {}, definition?: any) {
	return new ToolExecutionComponent(name, name, args, {}, definition, ui, process.cwd()) as any;
}

function renderComponent(component: any): string {
	return strip(component.render(WIDTH))
		.filter((line: string) => line.trim() !== "")
		.join("\n");
}

async function example(
	title: string,
	name: string,
	args: any,
	result?: string | object,
	definition?: any,
	options: { error?: boolean; expanded?: boolean } = {},
) {
	console.log(`\n── ${title} ──`);
	const component = tool(name, args, definition);
	if (options.expanded) component.setExpanded(true);
	if (result !== undefined) {
		const payload =
			typeof result === "string"
				? { content: [{ type: "text", text: result }], isError: Boolean(options.error) }
				: result;
		component.updateResult(payload);
	}
	console.log(renderComponent(component));
}

// ── 1. 运行中（pending）与完成（collapsed）──
const bash = tool("bash", { command: "rg -n 'renderCall' extensions/ --type ts" });
console.log(`\n── 运行中（Braille 转轮）──\n${renderComponent(bash)}`);
bash.updateResult({
	content: [
		{
			type: "text",
			text: "extensions/claude-code-style.ts:2532: renderCall(args, theme, context) {\nextensions/tool-diff/index.ts:45: renderCall() {}",
		},
	],
	isError: false,
});
console.log(`\n── 完成（✓ + 行数摘要）──\n${renderComponent(bash)}`);

await example(
	"read（path + offset/limit 详情）",
	"read",
	{ path: "extensions/index.ts", offset: 10, limit: 50 },
	Array.from({ length: 40 }, (_, index) => `  12 | export const line${index} = ${index}`).join("\n"),
);

await example("错误（✗ + 错误文本）", "read", { path: "missing.ts" }, "ENOENT: no such file or directory, open 'missing.ts'", undefined, {
	error: true,
});

await example(
	"展开（Input/Output 树）",
	"bash",
	{ command: "rg -n 'renderCall' extensions/" },
	"extensions/claude-code-style.ts:2532: renderCall(args, theme, context) {",
	undefined,
	{ expanded: true },
);

// ── 2. edit/write rich diff ──
const diff = [
	"@@ -1,3 +1,4 @@",
	" 1|import { run } from \"./runner\";",
	"-2|const threshold = 41;",
	"+2|const threshold = 42;",
	" 3|export default run;",
	"+4|export const version = \"0.8.30\";",
].join("\n");

const editCollapsed = tool("edit", { path: "sample.ts", oldText: "41", newText: "42" });
editCollapsed.updateResult({ details: { diff }, content: [] });
console.log(`\n── edit rich diff（收起）──\n${renderComponent(editCollapsed)}`);

// ── hover 对比：hint 行 muted → text ──
const longDiff = [
	"@@ -1,50 +1,50 @@",
	...Array.from({ length: 50 }, (_, i) => ` ${i + 1}|const value${i} = ${i}`),
	"-51|const old = 1",
	"+51|const old = 2",
].join("\n");
const hoverStore = new WriteExecutionMetadataStore();
const hintOf = (hovered: boolean) => {
	const comp = renderRichToolResult(
		"edit",
		{ details: { diff: longDiff }, content: [] },
		{ expanded: false, isHovered: () => hovered },
		ui.theme,
		{ args: { path: "sample.ts" } },
		hoverStore,
	);
	const hintLine = strip(comp.render(WIDTH)).find((line: string) => line.includes("more")) ?? "";
	return hintLine.trim();
};
console.log(`\n── diff hint（未悬浮）──\n${hintOf(false)}`);
console.log(`\n── diff hint（悬浮，text 色）──\n${hintOf(true)}`);
console.log(`\n── diff hint（展开态 warning 色）──`);
{
	const comp = renderRichToolResult(
		"edit",
		{ details: { diff: longDiff }, content: [] },
		{ expanded: true, isHovered: () => true },
		ui.theme,
		{ args: { path: "sample.ts" } },
		hoverStore,
	);
	console.log(strip(comp.render(WIDTH))
		.filter((line: string) => line.includes("more"))
		.join("\n").trim());
}

const editExpanded = tool("edit", { path: "sample.ts", oldText: "41", newText: "42" });
editExpanded.setExpanded(true);
editExpanded.updateResult({ details: { diff }, content: [] });
console.log(`\n── edit rich diff（展开）──\n${renderComponent(editExpanded)}`);

const store = new WriteExecutionMetadataStore();
store.set("w1", { fileExistedBeforeWrite: false });
const writeCreate = renderRichToolResult(
	"write",
	{ content: [{ type: "text", text: "Successfully wrote 11 bytes to NEW.md" }] },
	{ expanded: true },
	ui.theme,
	{ toolCallId: "w1", args: { path: "NEW.md", content: "const x = 1" } },
	store,
);
console.log(`\n── write rich diff（新建）──\n${renderComponent(writeCreate)}`);
store.set("w2", { fileExistedBeforeWrite: true, previousContent: "const y = 2" });
const writeOverwrite = renderRichToolResult(
	"write",
	{ content: [{ type: "text", text: "Successfully wrote 11 bytes to EXISTING.ts" }] },
	{ expanded: true },
	ui.theme,
	{ toolCallId: "w2", args: { path: "EXISTING.ts", content: "const x = 1" } },
	store,
);
console.log(`\n── write rich diff（覆盖）──\n${renderComponent(writeOverwrite)}`);

// ── 3. Task 系列 ──
const taskList = "#1 [in_progress] 重构 renderer\n#2 [pending] 补充测试\n#3 [completed] 发布 0.8.29";
await example("TaskList（收起，状态汇总）", "TaskList", {}, taskList);
await example("TaskList（展开，任务树）", "TaskList", {}, taskList, undefined, { expanded: true });
await example("TaskCreate（展开，单行格式化）", "TaskCreate", { subject: "重构 renderer" }, "Task #1 created successfully: 重构 renderer", undefined, {
	expanded: true,
});
await example("TaskExecute（展开）", "TaskExecute", { task_ids: ["1", "2", "3"] }, "Tasks #1, #2, #3", undefined, {
	expanded: true,
});
await example("TaskUpdate（展开）", "TaskUpdate", { taskId: "3" }, "Updated task #3 发布 0.8.29", undefined, { expanded: true });
await example("TaskStop（展开）", "TaskStop", { task_id: "1" }, "Task #1", undefined, { expanded: true });
await example("TaskGet", "TaskGet", { taskId: "3" }, "Task #3 [completed] 发布 0.8.29");
await example("TaskOutput", "TaskOutput", { task_id: "1" }, "build output line 1\nbuild output line 2");

// ── 4. Agent 家族 ──
await example(
	"Agent（后台启动）",
	"Agent",
	{ description: "探活 subagent", prompt: "…", subagent_type: "explore", run_in_background: true },
	"Agent started in background.\nAgent ID: 7d535698-4ad6-47a",
);
await example(
	"get_subagent_result",
	"get_subagent_result",
	{ agent_id: "7d535698-4ad6-47a" },
	"Agent: 7d535698-4ad6-47a\nType: explore | Status: completed | Tool uses: 4 | Duration: 5.2s\n\n顶层目录已列出。",
);
await example("steer_subagent", "steer_subagent", { agent_id: "7d535698-4ad6-47a", message: "停止" }, "Steering message sent");
await example("Agents（旧别名）", "Agents", { prompt: "并行调研" }, "3 agents launched");

// ── 5. 其他外部工具 ──
await example("skill", "skill", { name: "ponytail" }, "Skill completed");
await example("EnterPlanMode", "EnterPlanMode", {}, "Plan mode enabled");
await example("ExitPlanMode", "ExitPlanMode", { plan: "三步重构计划" }, "Plan presented");
await example("web_search", "web_search", { query: "pi coding agent extension" }, "1. result a\n2. result b\n3. result c");
await example("fetch_content", "fetch_content", { url: "https://example.com" }, "Page content extracted (3,200 chars)");
await example("ffgrep", "ffgrep", { pattern: "renderCall", path: "extensions/" }, "**无匹配**");

// ── 6. MCP 与自定义工具 ──
await example(
	"MCP 工具（MCP: 标签 → 人类可读标题）",
	"mcp_github_search",
	{ query: "pi" },
	"Found 3 repositories",
	{ name: "mcp_github_search", label: "MCP", description: "Search GitHub via Model Context Protocol" },
);
await example("自定义工具（驼峰 → 空格标题）", "custom_translate", { text: "hello world" }, "你好，世界");

// ── 7. 工具组（tool-grouping）──
{
	console.log(`\n── 工具组（收起，混合状态）──`);
	const grouping = installToolGrouping(() => true);
	const parent = new Container() as any;
	const read = tool("read", { path: "extensions/index.ts" });
	const gbash = tool("bash", { command: "npm test" });
	const grep = tool("ffgrep", { pattern: "renderCall", path: "extensions/" });
	parent.addChild(read);
	parent.addChild(new Spacer(1));
	parent.addChild(new Spacer(1));
	parent.addChild(new Spacer(1));
	parent.addChild(gbash);
	parent.addChild(grep);
	const group = parent.children[0];
	console.log(renderComponent(group));
	read.updateResult({ content: [{ type: "text", text: "40 lines loaded" }], isError: false });
	gbash.updateResult({ content: [{ type: "text", text: "pass 79/79" }], isError: false });
	grep.updateResult({ content: [{ type: "text", text: "no match" }], isError: true });
	console.log(`\n── 工具组（完成后）──\n${renderComponent(group)}`);
	group.setExpanded(true);
	console.log(`\n── 工具组（展开，完整背景卡片）──\n${renderComponent(group)}`);
	grouping.shutdown();
}

await events.get("session_shutdown")?.({}, { ui: { setStatus() {} } });
console.log("\n=== demo 完成 ===");
