import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import agentSummaryFeature, {
	AGENT_SUMMARY_ENTRY_TYPE,
} from "../extensions/feature/agent-summary.ts";
import { summaryMarkdown } from "../extensions/utils/agent-summary.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("agent-summary feature 注册 entry renderer，agent_end 渲染 markdown 引用块", async () => {
	initTheme("dark");
	const renderers = new Map<string, Function>();
	const appended: unknown[] = [];
	const events = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as any;

	agentSummaryFeature(fakePi);
	assert.ok(renderers.has(AGENT_SUMMARY_ENTRY_TYPE));

	// 模拟一个回合：2 个工具 → agent_end 追加摘要
	await events.get("agent_start")!();
	await events.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("agent_end")!();

	assert.equal(appended.length, 1);
	const data = (appended[0] as any).data;

	// 渲染：markdown 引用语法 `> [!TIP]`，内容斜体，灰色由主题 mdQuote 提供
	const renderer = renderers.get(AGENT_SUMMARY_ENTRY_TYPE);
	const component = renderer({ data }, { expanded: false }, {});
	assert.ok(component);
	const lines = (component as any).render(120).map(String);
	const plain = stripAnsi(lines.join("\n"));
	// 引用块渲染：无表格框、无标签，`>` 转为竖线前缀，斜体语法被消费
	assert.doesNotMatch(plain, /[┌├└]/, "不使用表格框");
	assert.doesNotMatch(plain, /TIP/);
	assert.match(plain, /Read 1 file, ran 1 command/);
	assert.doesNotMatch(plain, /\*/);

	// 空数据 → 无组件
	assert.equal(
		renderer(
			{ data: { reads: 0, edits: 0, commands: 0, others: 0, failed: 0, durationMs: 0 } },
			{ expanded: false },
			{},
		),
		undefined,
	);
});

test("summaryMarkdown box=true 输出引用块斜体，无标签", () => {
	const data = {
		reads: 2,
		edits: 1,
		commands: 3,
		others: 0,
		failed: 0,
		durationMs: 42_000,
	};
	assert.equal(
		summaryMarkdown(data, true),
		"> *Read 2 files, edited 1 file, ran 3 commands · 42s*",
	);
	assert.equal(
		summaryMarkdown(data, false),
		"**Read 2 files, edited 1 file, ran 3 commands · 42s**",
	);
});
