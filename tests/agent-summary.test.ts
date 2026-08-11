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

test("classifyTool 按旧 compact-style 口径分类", () => {
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "edit");
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名称不是 read/edit 精确名：归入 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary 统计：read/edit 按文件去重，bash 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true); // 失败
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 7);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		reads: 2,
		edits: 1,
		commands: 2,
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

test("summaryLine 纯文本（旧格式，首字母大写 + 耗时）", () => {
	const data: AgentSummaryData = {
		reads: 3,
		edits: 2,
		commands: 4,
		others: 1,
		failed: 1,
		durationMs: 61_000,
	};
	assert.equal(
		summaryLine(data),
		"Read 3 files, edited 2 files, 1 other tool, ran 4 commands, 1 failed · 1m 1s",
	);
	// 单数与无耗时
	assert.equal(
		summaryLine({ reads: 1, edits: 0, commands: 0, others: 0, failed: 0, durationMs: 500 }),
		"Read 1 file",
	);
	// 空统计 → 空字符串
	assert.equal(
		summaryLine({ reads: 0, edits: 0, commands: 0, others: 0, failed: 0, durationMs: 10_000 }),
		"",
	);
});

test("summaryMarkdown 整体加粗单行，box 可选提示框", () => {
	const data: AgentSummaryData = {
		reads: 2,
		edits: 1,
		commands: 3,
		others: 0,
		failed: 0,
		durationMs: 42_000,
	};
	// 默认整体加粗单行
	assert.equal(summaryMarkdown(data), "**Read 2 files, edited 1 file, ran 3 commands · 42s**");
	// box 模式：引用块 + 斜体，无标签
	assert.equal(
		summaryMarkdown(data, true),
		"> *Read 2 files, edited 1 file, ran 3 commands · 42s*",
	);
	assert.equal(summaryMarkdown({ ...data, reads: 0, edits: 0, commands: 0 }), "");
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
	assert.equal(calls.length, 0); // toolCount < 2 不回调

	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].reads, 1);

	// 下一回合重置（本回合 2 个工具才回调）
	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("tool_execution_start")!({ toolName: "grep", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		reads: 0,
		edits: 0,
		commands: 1,
		others: 1,
		failed: 0,
		durationMs: calls[1].durationMs, // 非 0
	});
});
