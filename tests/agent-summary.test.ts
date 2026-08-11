import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AgentRunSummary,
	bindAgentSummary,
	classifyTool,
	formatDuration,
	summaryLine,
	summaryMarkdown,
	type AgentSummaryData,
} from "../extensions/feature/agent-summary/core.ts";

test("classifyTool：bash/read/edit/write/other", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "write");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名不是精确工具名：归 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary：bash 计数；read/edit/write 按路径去重；other 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("write", { path: "d.ts" });
	summary.recordToolStart("write", { path: "d.ts" }); // 去重
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true);
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 9);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		commands: 2,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 1,
		failed: 1,
		durationMs: 60_000,
	} satisfies AgentSummaryData);
});

test("formatDuration 边界", () => {
	assert.equal(formatDuration(0), "");
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(62_000), "1m 2s");
	assert.equal(formatDuration(3_721_000), "1h 2m 1s");
});

test("summaryLine：bash→read→edit→write→other 顺序", () => {
	const data: AgentSummaryData = {
		commands: 4,
		reads: 3,
		edits: 2,
		writes: 1,
		others: 1,
		failed: 1,
		durationMs: 61_000,
	};
	assert.equal(
		summaryLine(data),
		"Ran 4 commands, read 3 files, edited 2 files, wrote 1 file, 1 other tool, 1 failed · 1m 1s",
	);
	assert.equal(
		summaryLine({
			commands: 0,
			reads: 1,
			edits: 0,
			writes: 0,
			others: 0,
			failed: 0,
			durationMs: 500,
		}),
		"Read 1 file",
	);
	assert.equal(
		summaryLine({
			commands: 0,
			reads: 0,
			edits: 0,
			writes: 0,
			others: 0,
			failed: 0,
			durationMs: 10_000,
		}),
		"",
	);
});

test("summaryMarkdown 整体加粗 / box 引用块", () => {
	const data: AgentSummaryData = {
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 0,
		failed: 0,
		durationMs: 42_000,
	};
	assert.equal(
		summaryMarkdown(data),
		"**Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s**",
	);
	assert.equal(
		summaryMarkdown(data, true),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s*",
	);
	assert.equal(
		summaryMarkdown({ ...data, commands: 0, reads: 0, edits: 0, writes: 0 }),
		"",
	);
});

test("bindAgentSummary 事件绑定：agent_start 重置、agent_end 回调", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;

	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 0); // toolCount < 2

	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].reads, 1);

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("tool_execution_start")!({ toolName: "grep", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		commands: 1,
		reads: 0,
		edits: 0,
		writes: 0,
		others: 1,
		failed: 0,
		durationMs: calls[1].durationMs,
	});
});
