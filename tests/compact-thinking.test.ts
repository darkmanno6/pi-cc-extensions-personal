import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
	animateCompactThinkingText,
	installCompactThinking,
} from "../extensions/feature/compact-thinking.ts";

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	previewLines: 0,
	animationIntervalMs: 30,
};

test("compact summary reuses compact-thinking's sweep animation", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => `<i>${text}</i>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as any;
	const first = animateCompactThinkingText("Thinking...", theme, 0);
	const second = animateCompactThinkingText("Thinking...", theme, 1);
	assert.notEqual(first, second);
	assert.equal(first.replace(/<[^>]+>/g, ""), "Thinking...");
	assert.equal(second.replace(/<[^>]+>/g, ""), "Thinking...");
});

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			appendEntry() {},
		} as any,
		emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

const tuiCtx = {
	mode: "tui",
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

const headlessCtx = {
	mode: "print",
	hasUI: false,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

test("compact thinking patches the runtime component with ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { emit, pi } = runtime();
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		// Lazy: prototype stays original until a TUI session starts.
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
		emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.equal(
			existsSync(join(dir, "compact-thinking.json")),
			false,
			"activate must not leave compact-thinking.json behind",
		);
	} finally {
		emit("session_shutdown", {}, tuiCtx);
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
		first.emit("session_start", {}, tuiCtx);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;

		installCompactThinking(second.pi, config);
		second.emit("session_start", {}, tuiCtx);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("headless subagent runtime does not steal the parent thinking patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-isolate-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const parent = runtime();
	const nested = runtime();
	try {
		installCompactThinking(parent.pi, config);
		parent.emit("session_start", {}, tuiCtx);
		const parentPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(parentPatch, original);

		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless install must not replace the parent prototype patch",
		);

		nested.emit("session_shutdown", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless shutdown must not tear down the parent patch",
		);
	} finally {
		parent.emit("session_shutdown", {}, tuiCtx);
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
			...(withAgent ? [{ type: "toolCall", name: "Agent", arguments: {} }] : []),
		],
	} as unknown as AssistantMessage;
}

function themeCtx(sessionManager: any = { getBranch: () => [], getEntries: () => [] }) {
	return {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
}

test("session tree restores durations from all entries so old messages keep Thought for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-restore-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
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
	const uiCtx = themeCtx(sessionManager);
	try {
		installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const oldTs = Date.now() - 60_000;
		durationEntry.data.messageTimestamp = oldTs;
		const msg = thinkingMessage(oldTs, false);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// compaction: session_tree with a leaf path that no longer includes the message
		emit("session_tree", {}, uiCtx);

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
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact summary keeps the shared animation alive until the next assistant message", async () => {
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	const controller = installCompactThinking(pi, config);
	try {
		emit("session_start", {}, uiCtx);
		const message = {
			...thinkingMessage(Date.now(), false),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "toolCall", name: "bash", args: {} },
			],
		};
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		controller.setCompactSummaryActive?.(true);
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		assert.equal(controller.isMessageThinkingActive?.(message.timestamp), false);
		const runningFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.ok((controller.getThinkingAnimationFrame?.() ?? 0) > runningFrame);

		controller.setCompactSummaryActive?.(false);
		const stoppedFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.equal(controller.getThinkingAnimationFrame?.(), stoppedFrame);
	} finally {
		emit("session_shutdown", {}, uiCtx);
	}
});

test("Agent tool execution keeps the thinking animation until the next boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	try {
		const controller = installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const ts = Date.now();
		const msg = thinkingMessage(ts, true); // thinking + Agent toolCall
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(controller.isMessageThinkingActive?.(ts), true);
		assert.ok(
			(controller.getThinkingAnimationFrame?.() ?? 0) > 0,
			"animation frame follows compact-thinking's configured timer",
		);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"active thinking exposes compact-thinking's live elapsed duration",
		);
		// toolcall_start carries the Agent toolCall: animation must survive
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// Real agent-loop order: message_end, then tool_execution_start(Agent).
		emit("message_end", { message: msg }, uiCtx);
		emit("tool_execution_start", { toolName: "Agent", toolCallId: "c1", args: {} }, uiCtx);

		// Nested headless runtime must not kill the ticker mid-run.
		const nested = runtime();
		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);

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

		// tool_execution_end(Agent): finalize once the subagent returns
		emit(
			"tool_execution_end",
			{ toolName: "Agent", toolCallId: "c1", result: {}, isError: false },
			uiCtx,
		);
		assert.equal(controller.isMessageThinkingActive?.(ts), false);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"completed thinking exposes its final duration",
		);
		const after = new AssistantMessageComponent(msg, true);
		after.updateContent(msg);
		const afterLines = renderText(after);
		assert.ok(
			afterLines.some((line) => line.startsWith("Thought for")),
			`finalized once the subagent ends, got: ${afterLines[0]}`,
		);

		nested.emit("session_shutdown", {}, headlessCtx);
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload/resume rebuild: mounted-tree scan re-renders rebuilt components", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-rescan-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { Container } = await import("@earendil-works/pi-tui");
	const parent = new Container() as any;
	const tui = {
		mode: "regular",
		getMountedRoots: () => [parent],
		requestRender() {},
	};
	const entries: any[] = [];
	const sessionManager = { getBranch: () => entries, getEntries: () => entries };
	const ctx = {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui);
			},
			requestRender() {},
		},
	} as any;
	const first = runtime();
	first.pi.appendEntry = (_type: string, data: unknown) =>
		entries.push({ type: "custom", customType: "compact-thinking-duration", data });
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, ctx);

		// live run: thinking then toolcall records the duration entry
		const ts = Date.now();
		const msg = thinkingMessage(ts, false);
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
			ctx,
		);

		first.emit("session_shutdown", { reason: "reload" }, ctx);

		// pi rebuildChatFromMessages: fresh components with the restored ORIGINAL prototype
		parent.clear();
		const rebuilt = new AssistantMessageComponent(msg, true) as any;
		parent.addChild(rebuilt);
		assert.ok(
			renderText(rebuilt).some((line) => line.startsWith("Thinking...")),
			"native rebuild shows the bare Thinking... label",
		);

		// new extension instance: session_start scans the mounted tree and re-renders
		const second = runtime();
		installCompactThinking(second.pi, config);
		second.emit("session_start", { reason: "reload" }, ctx);
		const lines = renderText(rebuilt);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`rebuilt component recovers its duration, got: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			!lines.some((line) => line.includes("Thinking...")),
			`no bare Thinking... fallback after reload, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", {}, ctx);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("completed run without duration never falls back to the loading label", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-fallback-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory({ requestRender() {} });
			},
			requestRender() {},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, useSummaryTitlesAsThinkingTitle: true });
		emit("session_start", {}, ctx);
		// completed run with no duration entry: summary title preferred, then "Thought"
		const withSummary = {
			...thinkingMessage(Date.now(), false),
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "**Plan**\n\nFirst do A",
					thinkingSignature: {
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Plan**\n\nFirst do A" }],
					},
				},
				{ type: "toolCall", name: "bash", args: {}, id: "c1" },
			],
		} as any;
		const component = new AssistantMessageComponent(withSummary, true) as any;
		component.updateContent(withSummary);
		const withSummaryLines = renderText(component);
		assert.ok(
			withSummaryLines.some((line) => line.includes("Plan")),
			`summary title shown for completed run, got: ${JSON.stringify(withSummaryLines)}`,
		);
		assert.ok(
			!withSummaryLines.some((line) => line.includes("Thinking...")),
			"no loading label for a completed run",
		);

		const plain = thinkingMessage(Date.now(), false);
		const plainComponent = new AssistantMessageComponent(plain, true) as any;
		plainComponent.updateContent(plain);
		const plainLines = renderText(plainComponent);
		assert.ok(
			plainLines.some((line) => line.includes("Thought")),
			`neutral fallback for run without title or duration, got: ${JSON.stringify(plainLines)}`,
		);
		assert.ok(
			!plainLines.some((line) => line.includes("Thinking...")),
			"no loading label fallback",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
