import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

import { installCompactThinking } from "../extensions/compact-thinking.ts";

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	previewLines: 0,
	animationIntervalMs: 30,
};

function runtime() {
	const handlers = new Map<string, Function>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
			appendEntry() {},
		} as any,
	};
}

const ctx = {
	mode: "tui",
	sessionManager: { getBranch: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

test("compact thinking patches the runtime component and mirrors ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { handlers, pi } = runtime();
	writeFileSync(join(dir, "compact-thinking.json"), "invalid", "utf8");
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "compact-thinking.json"), "utf8")), config);
	} finally {
		handlers.get("session_shutdown")?.({}, {});
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps the replacement compact-thinking prototype patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installCompactThinking(first.pi, config);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;
		first.handlers.get("session_start")?.({}, ctx);

		installCompactThinking(second.pi, config);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

const renderText = (component: any, width = 120): string[] =>
	component
		.render(width)
		.map((line: string) =>
			line
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
				.replace(/\x1b\][^\x07]*\x07/g, "")
				.trim(),
		)
		.filter((line: string) => line);

function thinkingMessage(timestamp: number, withAgent = true) {
	return {
		role: "assistant",
		timestamp,
		content: [
			{
				type: "thinking",
				thinking: "plan",
				thinkingSignature: { kind: "agent_summary", title: "Plan", body: "..." },
			},
			...(withAgent ? [{ type: "toolCall", name: "Agent", args: {} }] : []),
		],
	};
}

test("session tree restores durations from all entries so old messages keep Thought for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-restore-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { handlers, pi } = runtime();
	let durationEntry: any = {
		type: "custom",
		customType: "compact-thinking-duration",
		data: { messageTimestamp: 0, contentIndex: 0, durationMs: 1234 },
	};
	const sessionManager = {
		// getBranch mirrors the leaf path after compaction: it no longer contains
		// the finished message's duration entry. getEntries still has it.
		getBranch: () => [] as any[],
		getEntries: () => [durationEntry],
	};
	const uiCtx = {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
	try {
		installCompactThinking(pi, config);
		handlers.get("session_start")?.({}, uiCtx);

		const oldTs = Date.now() - 60_000;
		durationEntry.data.messageTimestamp = oldTs;
		const msg = thinkingMessage(oldTs, false);
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// compaction: session_tree with a leaf path that no longer includes the message
		handlers.get("session_tree")?.({}, uiCtx);

		// scrolling back re-renders the old message in a fresh component
		const old = new AssistantMessageComponent(msg, true);
		old.updateContent(msg);
		const lines = renderText(old);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`old message keeps its duration after compaction, got: ${lines[0]}`,
		);
		assert.ok(!lines.some((line) => line.includes("Thinking...")), "no bare Thinking... fallback");
	} finally {
		handlers.get("session_shutdown")?.({}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Agent tool execution keeps the thinking animation until the next boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { handlers, pi } = runtime();
	const uiCtx = {
		mode: "tui",
		sessionManager: { getBranch: () => [] as any[], getEntries: () => [] as any[] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
	try {
		installCompactThinking(pi, config);
		handlers.get("session_start")?.({}, uiCtx);

		const ts = Date.now();
		const msg = thinkingMessage(ts, true); // thinking + Agent toolCall
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		// toolcall_start carries the Agent toolCall: animation must survive
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		const midAgent = new AssistantMessageComponent(msg, true);
		midAgent.updateContent(msg);
		const midLines = renderText(midAgent);
		assert.ok(
			midLines.some((line) => line.includes("Thinking")),
			`during Agent execution the thinking ticker stays active, got: ${midLines[0]}`,
		);
		assert.ok(
			!midLines.some((line) => line.includes("Thought for")),
			"not finalized while the subagent runs",
		);

		// tool_execution_start(Agent): keep animating (already active, no-op)
		handlers.get("tool_execution_start")?.(
			{ toolName: "Agent", toolCallId: "c1", args: {} },
			uiCtx,
		);
		const duringAgent = new AssistantMessageComponent(msg, true);
		duringAgent.updateContent(msg);
		assert.ok(
			!renderText(duringAgent).some((line) => line.includes("Thought for")),
			"still not finalized while the subagent runs",
		);

		// model emits text after the subagent returns: finalize
		handlers.get("message_update")?.({
			message: msg,
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		});
		const after = new AssistantMessageComponent(msg, true);
		after.updateContent(msg);
		const afterLines = renderText(after);
		assert.ok(
			afterLines.some((line) => line.startsWith("Thought for")),
			`finalized once the model continues, got: ${afterLines[0]}`,
		);
	} finally {
		handlers.get("session_shutdown")?.({}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
