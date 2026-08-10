import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { config, normalizeConfig } from "../extensions/config/config.ts";
import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";
import {
	buildMessageSummary,
	installCompactMode,
	isCompactAssistantComponent,
	refreshCompactModeComponents,
} from "../extensions/renderer/compact-mode.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/message-display.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool-diff/write-execution.ts";
import { invalidateIoView, isExpandedToolIoView } from "../extensions/renderer/tool-result.ts";

initTheme("dark");

const ui = {
	theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	requestRender() {},
} as any;

function tool(name: string, id: string, args: any = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, ui, process.cwd()) as any;
}

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

/** 安装 compact 补丁并把全局 mode 设为 compact；restore 恢复原模式并卸载。 */
function installHooks() {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	return {
		hooks,
		restore() {
			config.mode = previousMode;
			hooks.shutdown();
		},
	};
}

function toolCallMessage(timestamp: number, name = "bash") {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "toolCall", name, arguments: { command: "echo" } }],
	};
}

test("buildMessageSummary: duration first, read dedup by path, counts, first-seen order, edit/write excluded", () => {
	const query = {
		getMessageThinkingDurationMs: (timestamp: number) => (timestamp === 1 ? 8500 : undefined),
	};
	const message = {
		timestamp: 1,
		content: [
			{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", name: "read", arguments: { path: "b.ts" } },
			{ type: "toolCall", name: "bash", arguments: { command: "echo" } },
			{ type: "toolCall", name: "edit", arguments: {} },
			{ type: "toolCall", name: "write", arguments: {} },
			{ type: "toolCall", name: "grep", arguments: { pattern: "x" } },
		],
	};
	assert.equal(buildMessageSummary(message, query), "Thought for 9s, read×2, bash×1, grep×1");
	assert.equal(
		buildMessageSummary(message, {
			getMessageThinkingDurationMs: () => 8500,
			isMessageThinkingActive: () => true,
		}),
		"Thinking... · 9s, read×2, bash×1, grep×1",
	);
	// 新 message 独立：计数不跨消息累积；无时长无工具时为空串。
	assert.equal(buildMessageSummary({ timestamp: 2, content: [] }, query), "");
	assert.equal(
		buildMessageSummary(
			{ timestamp: 3, content: [] },
			{ getMessageThinkingDurationMs: () => undefined },
		),
		"",
	);
	assert.equal(
		buildMessageSummary(
			{ timestamp: 3, content: [{ type: "toolCall", name: "bash", arguments: {} }] },
			query,
		),
		"bash×1",
	);
	// read 空路径不按路径去重（计入计数）。
	assert.equal(
		buildMessageSummary(
			{ timestamp: 4, content: [{ type: "toolCall", name: "read", arguments: {} }] },
			query,
		),
		"read×1",
	);
	assert.doesNotMatch(
		buildMessageSummary(
			{ timestamp: 5, content: [{ type: "toolCall", name: "bad\x1b]8;;https://x\x07tool" }] },
			query,
		),
		/[\x1b\x07]/,
	);
});

test("config normalize keeps compact, defaults to on, command completions order on,compact,off", () => {
	assert.equal(normalizeConfig({ mode: "compact" }).mode, "compact");
	assert.equal(normalizeConfig({}).mode, "on");
	assert.equal(normalizeConfig({ enabled: false }).mode, "off");
	assert.equal(normalizeConfig({ enabled: true }).mode, "on");
	assert.equal(normalizeConfig({ mode: "legacy" }).mode, "on");

	let completions: Array<{ value: string }> = [];
	const pi: any = {
		registerCommand(name: string, options: any) {
			if (name === "ccstyle") completions = options.getArgumentCompletions("");
		},
		registerTool() {},
		on() {},
	};
	const previousMode = config.mode;
	try {
		claudeCodeStyleExtension(pi, { mode: "on" });
		assert.deepEqual(
			completions.map((item) => item.value),
			["on", "compact", "off", "status", "panel"],
		);
	} finally {
		config.mode = previousMode;
	}
});

test("compact collapses tool-calling assistant to one line; native render outside compact", () => {
	const { restore } = installHooks();
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const collapsed = renderText(assistant);
		assert.equal(collapsed.length, 1, "tool-calling assistant collapses to a single line");
		assert.match(collapsed[0], /^Thinking\.\.\., bash×1/);
		assert.match(collapsed[0], /click to show more/);
		const narrow = assistant.render(30);
		assert.equal(narrow[0], "", "compact summary keeps one leading blank row");
		assert.equal(
			narrow.filter((line: string) => line.trim()).length,
			1,
			"compact summary never wraps",
		);
		assert.ok(narrow.every((line: string) => visibleWidth(line) <= 30));

		// 普通工具折叠时不显示独立行（摘要行已统计）。
		const read = tool("read", "r1", { path: "a.ts" });
		read.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		assert.deepEqual(renderText(read), []);

		// 无 toolCall 的 final assistant 走原生渲染。
		const finalMessage = { role: "assistant", content: [{ type: "text", text: "task done" }] };
		const final = new AssistantMessageComponent(finalMessage, true) as any;
		final.updateContent(finalMessage);
		assert.match(renderText(final).join("\n"), /task done/);

		// 切 on：assistant 与 tool 都走原生。
		config.mode = "on";
		assistant.updateContent(msg);
		assert.ok(!renderText(assistant).some((line) => /Thinking\.\.\., bash×1/.test(line)));
		assert.ok(renderText(read).length > 0, "tool renders natively in on mode");

		// 切 off：同样原生。
		config.mode = "off";
		assistant.updateContent(msg);
		assert.ok(!renderText(assistant).some((line) => /Thinking\.\.\., bash×1/.test(line)));
		assert.ok(renderText(read).length > 0, "tool renders natively in off mode");
	} finally {
		restore();
	}
});

test("consecutive tool-call messages accumulate into one round until the next visible assistant text", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	const durations = new Map([
		[1, 400],
		[2, 500],
		[3, 600],
		[4, 3000],
	]);
	let activeTimestamp: number | undefined;
	let animationFrame = 0;
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: (timestamp) => durations.get(timestamp),
			isMessageThinkingActive: (timestamp) => timestamp === activeTimestamp,
			getThinkingAnimationFrame: () => animationFrame,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const message1 = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "first" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const message2 = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "second" },
				{ type: "toolCall", id: "f1", name: "fffind", arguments: { pattern: "x" } },
			],
		};
		const message3 = {
			role: "assistant",
			timestamp: 3,
			content: [
				{ type: "thinking", thinking: "third" },
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } },
			],
		};
		const assistant1 = new AssistantMessageComponent(message1 as any, true) as any;
		assistant1.updateContent(message1);
		activeTimestamp = 2;
		const message2Thinking = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "thinking", thinking: "second" }],
		};
		const assistant2 = new AssistantMessageComponent(message2Thinking as any, true) as any;
		assistant2.updateContent(message2Thinking as any);
		assert.match(renderText(assistant1).join("\n"), /^Thinking\.\.\. · 900ms, bash×1/);
		assert.doesNotMatch(renderText(assistant1).join("\n"), /Thought for/);
		animationFrame = 1;
		assert.match(renderText(assistant1).join("\n"), /^Thinking\.\.\. · 900ms, bash×1/);

		activeTimestamp = undefined;
		assistant2.updateContent(message2);
		const assistant3 = new AssistantMessageComponent(message3 as any, true) as any;
		assistant3.updateContent(message3);

		assert.deepEqual(renderText(assistant2), []);
		assert.deepEqual(renderText(assistant3), []);
		assert.match(
			renderText(assistant1).join("\n"),
			/^Thinking\.\.\. · 2s, bash×2, fffind×1, read×1/,
		);

		const bash = tool("bash", "b1", { command: "one" });
		const longOutput = Array.from({ length: 500 }, (_, index) => `tool output ${index}`).join("\n");
		bash.updateResult({ content: [{ type: "text", text: longOutput }], isError: false });
		bash.setExpanded(true);
		assert.equal(bash.expanded, true, "precondition: child can be expanded before its round");
		const edit = tool("edit", "e1", { path: "a.ts" });
		edit.updateResult({ content: [], isError: false });
		const backgroundSlots: string[] = [];
		const cardTheme = Object.assign(Object.create(previousTheme ?? null), {
			fg: previousTheme?.fg ?? ((_color: string, text: string) => text),
			bg(slot: string, text: string) {
				backgroundSlots.push(slot);
				return text;
			},
		});
		setMessageDisplayTheme(cardTheme);
		assistant1.setExpanded(true);
		assert.equal(bash.expanded, false, "round children default to collapsed");
		bash.setExpanded(true);
		assert.equal(bash.expanded, false, "global expansion cannot recursively expand round children");
		assert.equal(edit.expanded, false, "edit/write keep independent expansion state");
		const cardLines = assistant1.render(80);
		assert.match(renderText(assistant1).join("\n"), /495 earlier lines/);
		assert.ok(cardLines.length < 30, "collapsed children cap long output inside the round card");
		assert.equal(cardLines[0], "", "expanded round keeps the normal card spacer");
		assert.ok(
			cardLines.slice(1).every((line: string) => visibleWidth(line) === 80),
			"expanded round is wrapped by one width-safe tool card",
		);
		assert.deepEqual([...new Set(backgroundSlots)], ["userMessageBg"]);
		setMessageDisplayTheme(previousTheme);
		assert.deepEqual(renderText(bash), [], "round tools render only inside the summary card");
		assistant1.setExpanded(false);
		assert.equal(bash.expanded, false, "collapsing the round keeps its children collapsed");

		const finalMessage = {
			role: "assistant",
			timestamp: 4,
			content: [
				{ type: "thinking", thinking: "final thought" },
				{ type: "text", text: "final answer" },
			],
		};
		activeTimestamp = 4;
		const finalThinking = {
			role: "assistant",
			timestamp: 4,
			content: [{ type: "thinking", thinking: "final thought" }],
		};
		const final = new AssistantMessageComponent(finalThinking as any, true) as any;
		final.updateContent(finalThinking as any);
		assert.match(renderText(assistant1).join("\n"), /^Thinking\.\.\. · 5s, bash×2/);

		activeTimestamp = undefined;
		final.updateContent(finalMessage);
		assert.match(renderText(assistant1).join("\n"), /^Thought for 5s, bash×2/);
		assert.match(renderText(final).join("\n"), /final answer/);
		assert.doesNotMatch(renderText(final).join("\n"), /Thought|final thought/);

		const nextMessage = {
			role: "assistant",
			timestamp: 5,
			content: [
				{ type: "text", text: "next round" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		};
		const next = new AssistantMessageComponent(nextMessage as any, true) as any;
		next.updateContent(nextMessage);
		const nextLines = renderText(next).join("\n");
		assert.match(nextLines, /next round/);
		assert.match(nextLines, /Thinking\.\.\., grep×1/);
		assert.doesNotMatch(nextLines, /bash×2/);
		assert.match(renderText(assistant1).join("\n"), /^Thought for 5s, bash×2/);
	} finally {
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("compact edit/write stays single-line when collapsed and reuses rich diff when expanded", () => {
	const metadata = new WriteExecutionMetadataStore();
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: metadata });
	try {
		const edit = tool("edit", "e1", { path: "a.ts" });
		edit.updateResult({
			content: [],
			details: {
				diff: "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
			},
			isError: false,
		});
		assert.equal(edit.render(120)[0], "", "compact file rows keep one leading blank row");
		const collapsed = renderText(edit).join("\n");
		assert.match(collapsed, /edit a\.ts \(\+1 -1\)/);
		assert.doesNotMatch(collapsed, /diff --git|^---|^\+\+\+|^@@/);

		setMessageDisplayTheme({
			fg: (color: string, text: string) =>
				color === "success" || color === "error" ? `<${color}>${text}</${color}>` : text,
		} as any);
		const coloredStats = edit.render(120).join("\n");
		assert.match(coloredStats, /<success>\+1<\/success>/);
		assert.match(coloredStats, /<error>-1<\/error>/);
		setMessageDisplayTheme(previousTheme);

		// expanded：保留标题/统计行，并复用 mode=on 的 rich diff 和展开卡背景。
		const backgroundSlots: string[] = [];
		const cardTheme = Object.assign(Object.create(previousTheme ?? null), {
			fg: previousTheme?.fg ?? ((_color: string, text: string) => text),
			bg(slot: string, text: string) {
				backgroundSlots.push(slot);
				return text;
			},
		});
		setMessageDisplayTheme(cardTheme);
		edit.expanded = true;
		const expanded = renderText(edit).join("\n");
		assert.match(expanded, /edit a\.ts \(\+1 -1\)/);
		assert.match(expanded, /old/);
		assert.match(expanded, /new/);
		assert.doesNotMatch(expanded, /Input|Output|Details:/);
		assert.ok(backgroundSlots.includes("userMessageBg"));
		setMessageDisplayTheme(previousTheme);

		// edit 缺 diff 时统计未知，不能伪报 (+0 -0)。
		const unknownEdit = tool("edit", "e2", { path: "unknown.ts" });
		unknownEdit.updateResult({
			content: [{ type: "text", text: "fallback output" }],
			isError: false,
		});
		assert.doesNotMatch(renderText(unknownEdit).join("\n"), /\(\+\d+ -\d+\)/);
		unknownEdit.expanded = true;
		const unknownEditExpanded = renderText(unknownEdit).join("\n");
		assert.equal(isExpandedToolIoView(unknownEdit.resultRendererComponent), true);
		assert.match(unknownEditExpanded, /Input/);
		assert.match(unknownEditExpanded, /Output/);
		assert.match(unknownEditExpanded, /fallback output/);
		assert.doesNotThrow(
			() => invalidateIoView(unknownEdit.resultRendererComponent),
			"fallback IO hover keeps ToolExecutionComponent.invalidate bound",
		);

		// write 无变更成功：仍显示 (+0 -0)。
		const write = tool("write", "w1", { path: "b.ts", content: "" });
		metadata.set("w1", { fileExistedBeforeWrite: true, previousContent: "" });
		write.updateResult({ content: [], isError: false });
		assert.match(renderText(write).join("\n"), /write b\.ts \(\+0 -0\)/);

		// 元数据缺失时不能把覆盖写入伪装成新文件。
		const unknownWrite = tool("write", "w2", { path: "unknown.ts", content: "line" });
		unknownWrite.updateResult({
			content: [{ type: "text", text: "write fallback" }],
			isError: false,
		});
		assert.doesNotMatch(renderText(unknownWrite).join("\n"), /\(\+\d+ -\d+\)/);
		unknownWrite.expanded = true;
		const unknownWriteExpanded = renderText(unknownWrite).join("\n");
		assert.equal(isExpandedToolIoView(unknownWrite.resultRendererComponent), true);
		assert.match(unknownWriteExpanded, /Input/);
		assert.match(unknownWriteExpanded, /Output/);

		// 大文件超过精确统计预算时省略数字，不显示误导性的全量替换统计。
		const oldLines = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
		const newLines = oldLines.replace("line 250", "changed");
		const largeWrite = tool("write", "w3", { path: "large.ts", content: newLines });
		metadata.set("w3", { fileExistedBeforeWrite: true, previousContent: oldLines });
		largeWrite.updateResult({ content: [], isError: false });
		assert.doesNotMatch(renderText(largeWrite).join("\n"), /\(\+\d+ -\d+\)/);

		// compact 路径、Input 和 Output 都不能保留终端控制序列。
		const unsafeWrite = tool("write", "w4", {
			path: "safe.ts\x1b]8;;https://evil\x07link\x1b]8;;\x07",
			content: "\x1b[31mcontent",
		});
		metadata.set("w4", { fileExistedBeforeWrite: false });
		unsafeWrite.updateResult({
			content: [{ type: "text", text: "\x1b]0;owned\x07done" }],
			isError: false,
		});
		unsafeWrite.expanded = true;
		assert.doesNotMatch(unsafeWrite.render(120).join("\n"), /\x1b\]|\x1b\[31m|\x07/);

		// write 展开同样走 rich diff；无变更时显示默认结果，不回退 Input/Output。
		write.expanded = true;
		const writeExpanded = renderText(write).join("\n");
		assert.match(writeExpanded, /write b\.ts \(\+0 -0\)/);
		assert.doesNotMatch(writeExpanded, /Input|Output|Details:/);
	} finally {
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("sync collects mounted resume components before applying global expansion", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const msg = toolCallMessage(7);
	const assistant = new AssistantMessageComponent(msg, true) as any;
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		refreshCompactModeComponents({ children: [assistant] });
		hooks.sync({ ui: { getToolsExpanded: () => true } });
		assert.equal(assistant.expanded, true);
		assert.equal(typeof assistant.setExpanded, "function");
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("shutdown restores prototypes; reload replaces the patch without recursion", () => {
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const originalUpdateContent = assistantPrototype.updateContent;
	const originalRender = toolPrototype.render;
	const originalUpdateDisplay = toolPrototype.updateDisplay;
	const previousMode = config.mode;
	config.mode = "compact";
	const first = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		assert.notEqual(assistantPrototype.updateContent, originalUpdateContent);
		const firstPatch = assistantPrototype.updateContent;
		const msg = toolCallMessage(9);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const firstSetter = assistant.setExpanded;
		assert.equal(typeof firstSetter, "function");

		const second = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
		const secondPatch = assistantPrototype.updateContent;
		assert.notEqual(secondPatch, firstPatch, "reload installs a fresh patch");
		assert.notEqual(secondPatch, originalUpdateContent);
		assert.equal(assistant.setExpanded, undefined, "reload detaches the previous instance patch");

		// 现有 transcript 组件由新补丁重新接管，且不递归到旧 round 闭包。
		assistant.updateContent(msg);
		assert.equal(renderText(assistant).length, 1);
		assert.equal(typeof assistant.setExpanded, "function");
		assert.notEqual(assistant.setExpanded, firstSetter);
		assert.equal(isCompactAssistantComponent(assistant), true);

		first.shutdown();
		assert.equal(
			assistantPrototype.updateContent,
			secondPatch,
			"stale shutdown keeps the new patch",
		);
		second.shutdown();
		assert.equal(assistantPrototype.updateContent, originalUpdateContent);
		assert.equal(toolPrototype.render, originalRender);
		assert.equal(toolPrototype.updateDisplay, originalUpdateDisplay);
	} finally {
		config.mode = previousMode;
		if (assistantPrototype.updateContent !== originalUpdateContent) {
			assistantPrototype.updateContent = originalUpdateContent;
		}
		if (toolPrototype.render !== originalRender) toolPrototype.render = originalRender;
		if (toolPrototype.updateDisplay !== originalUpdateDisplay) {
			toolPrototype.updateDisplay = originalUpdateDisplay;
		}
	}
});

test("isCompactAssistantComponent gates on compact mode; setExpanded no-ops outside", () => {
	const { restore } = installHooks();
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		assert.equal(isCompactAssistantComponent(assistant), true);

		let updates = 0;
		const originalUpdate = assistant.updateContent.bind(assistant);
		assistant.updateContent = (message: any) => {
			updates++;
			return originalUpdate(message);
		};

		// compact 下 setExpanded 更新整轮展开状态。
		assistant.setExpanded(true);
		assert.equal(assistant.expanded, true);

		// 切 on：识别失效，setExpanded 只保持原生字段不触发重绘。
		config.mode = "on";
		assert.equal(isCompactAssistantComponent(assistant), false);
		const before = updates;
		const expandedBefore = assistant.expanded;
		assistant.setExpanded(false);
		assert.equal(updates, before, "setExpanded is a no-op outside compact mode");
		assert.equal(assistant.expanded, expandedBefore);
		assert.equal(typeof assistant.setExpanded, "undefined");

		// on 模式新实例不装 setExpanded（不产生 compact 标记）。
		const fresh = new AssistantMessageComponent(msg, true) as any;
		fresh.updateContent(msg);
		assert.equal(typeof fresh.setExpanded, "undefined");
		assert.equal(isCompactAssistantComponent(fresh), false);
	} finally {
		restore();
	}
});

test("unknown assistant wrappers keep ownership without creating a recursion cycle", () => {
	const prototype = AssistantMessageComponent.prototype as any;
	const original = prototype.updateContent;
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	const compactPatch = prototype.updateContent;
	const external = function (this: any, message: any) {
		return compactPatch.call(this, message);
	};
	prototype.updateContent = external;
	try {
		hooks.assertOwnership();
		assert.equal(prototype.updateContent, external);
		const msg = toolCallMessage(11);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		assert.equal(renderText(assistant).length, 1);
	} finally {
		hooks.shutdown();
		prototype.updateContent = original;
		config.mode = previousMode;
	}
});

test("session_start and session_tree keep the compact patch outermost over compact-thinking", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-mode-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const events = new Map<string, Function[]>();
	const pi: any = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(name: string, handler: Function) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
		},
	};
	const emit = async (name: string, event: any, context: any) => {
		for (const handler of events.get(name) ?? []) await handler(event, context);
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				italic: (text: string) => text,
				bold: (text: string) => text,
			},
			setStatus() {},
			requestRender() {},
			setWidget() {},
		},
	};
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const originalUpdateContent = assistantPrototype.updateContent;
	const originalToolUpdateDisplay = toolPrototype.updateDisplay;
	try {
		claudeCodeStyleExtension(pi, { mode: "compact" });
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		await emit("session_start", {}, ctx);
		// renderer 的 session_start 先于 compact-thinking 执行；延迟 sync 重新认领。
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		const msg = toolCallMessage(Date.now());
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const lines = renderText(component);
		assert.equal(lines.length, 1, "compact summary stays outermost over the thinking patch");
		assert.match(lines[0], /bash×1/);

		// session_tree 后 resume 历史仍由 compact 补丁外层持有。
		await emit("session_tree", {}, ctx);
		const nextMessage = {
			...toolCallMessage(Date.now() + 1),
			content: [
				{ type: "text", text: "next" },
				{ type: "toolCall", name: "bash", arguments: { command: "echo" } },
			],
		};
		const afterTree = new AssistantMessageComponent(nextMessage as any, true) as any;
		afterTree.updateContent(nextMessage);
		assert.match(renderText(afterTree).join("\n"), /bash×1/);

		// shutdown 恢复原生原型。
		await emit("session_shutdown", {}, ctx);
		assert.equal(assistantPrototype.updateContent, originalUpdateContent);
		assert.equal(toolPrototype.updateDisplay, originalToolUpdateDisplay);
	} finally {
		config.mode = previousMode;
		await emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
