import assert from "node:assert/strict";
import test from "node:test";

import claudeCodeStyleExtension, {
	fixedEditorWheelDispatchCount,
	installToolMouseInteraction,
} from "../extensions/claude-code-style.ts";

test("fixed editor wheel dispatch averages five rows per tick", () => {
	installToolMouseInteraction({}, false);
	assert.deepEqual((["up", "up", "up"] as const).map(fixedEditorWheelDispatchCount), [1, 2, 2]);
	assert.deepEqual(
		(["down", "down", "down"] as const).map(fixedEditorWheelDispatchCount),
		[1, 2, 2],
	);
});

test("tool click uses fixed-editor visible rows without previousViewportTop", async () => {
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let expandedToolId: string | null = null;
	let editorInputCount = 0;
	const renderRequests: unknown[] = [];
	const createTool = (toolCallId: string, title: string) => ({
		toolCallId,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
			return ["", title, "  └ 1 line output (ctrl+o expand / click)"];
		},
	});
	const offscreenTool = createTool("tool-offscreen", "✓ Bash(echo old)");
	const visibleTool = createTool("tool-visible", "✓ Bash(echo ok)");
	const transcript = {
		children: [offscreenTool, visibleTool],
		render(width: number) {
			return this.children.flatMap((child) => child.render(width));
		},
	};
	const editor = {
		getText: () => "",
		setText() {},
		handleInput() {
			editorInputCount++;
		},
		render: () => ["editor"],
	};
	const status = { render: () => ["status"] };
	const above = { children: [] as any[], render: () => [] as string[] };
	const editorContainer = { children: [editor], render: () => ["editor"] };
	const below = { render: () => ["below"] };
	const footer = { render: () => ["footer"] };
	const terminalPrototype = {
		get rows() {
			return 30;
		},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), {
		columns: 80,
		write() {},
	});
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });

	const tui = {
		terminal,
		children: [transcript, status, above, editorContainer, below, footer],
		focusedComponent: editor,
		// Zentui exposes only the three-row visible transcript window here.
		previousLines: ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"],
		// previousViewportTop is unrelated cursor bookkeeping.
		previousViewportTop: 17,
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
		handleInput(data: string) {
			if (data === "\x1b[5;9~" && transcript.children.length > 0) {
				this.previousLines = ["", "✓ Bash(echo old)", "  └ 1 line output (ctrl+o expand / click)"];
			} else if (data === "\x1b[6~" && transcript.children.length > 0) {
				this.previousLines = ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
			}
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const ui = {
		setStatus() {},
		setWidget(_key: string, factory: any) {
			if (!factory) return;
			scrollButton = factory(tui, { fg: (_color: string, text: string) => text });
			above.children.push(scrollButton);
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			inputListeners.add(handler);
			return () => inputListeners.delete(handler);
		},
	};
	let scrollButton: any;
	const events = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		on(name: string, handler: (...args: any[]) => any) {
			events.set(name, handler);
		},
	};

	claudeCodeStyleExtension(pi as any, { fixedEditorFeatures: true });
	await events.get("session_start")?.({}, { mode: "tui", hasUI: true, ui });
	tui.handleInput("\x1b[<0;20;3M");
	assert.equal(expandedToolId, "tool-visible");
	assert.equal(offscreenTool.expanded, false);
	assert.equal(visibleTool.expanded, true);

	// PageUp shows the affordance after the viewport actually moves, and a new
	// assistant message is counted.
	tui.handleInput("\x1b[5;9~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	events.get("message_start")?.({ message: { role: "assistant" } }, {});
	assert.match(scrollButton.render(80)[0], /1 new message/);
	assert.match(scrollButton.render(80)[0], /Ctrl\+End/);

	// PageDown reaching the root tail hides the button and clears the count.
	tui.handleInput("\x1b[6~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.deepEqual(scrollButton.render(80), []);

	// Ctrl+End jumps through Zentui's normal Enter path without submitting.
	tui.handleInput("\x1b[5;9~");
	const editorInputsBeforeShortcut = editorInputCount;
	tui.handleInput("\x1b[8^");
	assert.deepEqual(scrollButton.render(80), []);
	assert.equal(editorInputCount, editorInputsBeforeShortcut);

	// Pi rebuilds the transcript on compaction without session_start. If another
	// fixed-editor owner replaces the root dispatcher, ccstyle must wrap it again.
	const replacementHandle = function (this: typeof tui, data: string) {
		for (const listener of inputListeners) {
			if (listener(data)?.consume) return;
		}
		this.focusedComponent?.handleInput?.(data);
	};
	tui.handleInput = replacementHandle;
	tui.previousLines = ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
	visibleTool.expanded = false;
	expandedToolId = null;
	await events.get("session_compact")?.({}, { mode: "tui", hasUI: true, ui });
	assert.notEqual(
		tui.handleInput,
		replacementHandle,
		"compaction reclaims the root input dispatcher",
	);
	tui.handleInput("\x1b[<0;20;3M");
	assert.equal(expandedToolId, "tool-visible");

	// An empty transcript cannot move, so PageUp must never flash the affordance.
	transcript.children = [];
	tui.previousLines = [];
	tui.handleInput("\x1b[5;9~");
	assert.deepEqual(scrollButton.render(80), []);
	await new Promise<void>((resolve) => setTimeout(resolve, 80));
	assert.deepEqual(scrollButton.render(80), []);

	// Startup continuation, /reload, and /resume populate or rebuild transcripts
	// at different lifecycle points. All need a deferred forced repaint instead
	// of waiting for terminal input to reveal restored rows.
	for (const reason of ["startup", "reload", "resume"]) {
		renderRequests.length = 0;
		await events.get("session_start")?.({ reason }, { mode: "tui", hasUI: true, ui });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.ok(renderRequests.includes(true), `${reason} forces a deferred repaint`);
	}

	renderRequests.length = 0;
	await events.get("session_start")?.({ reason: "reload" }, { mode: "tui", hasUI: true, ui });
	await events.get("session_shutdown")?.({}, { mode: "tui", hasUI: true, ui });
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.ok(!renderRequests.includes(true), "shutdown cancels the deferred repaint");
});

test("collapsing a fixed-editor tool compensates removed rows", async () => {
	let wheelDownDispatches = 0;
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	inputListeners.add((data) => {
		if (/^\x1b\[<65;/.test(data)) wheelDownDispatches++;
		return undefined;
	});
	const tool = {
		toolCallId: "tool-expanded",
		expanded: true,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return this.expanded
				? ["", "✓ Bash(echo ok)", "  │ one", "  │ two", "  │ three", "  │ four", "  │ five"]
				: ["", "✓ Bash(echo ok)", "  └ 5 lines (ctrl+o expand / click)"];
		},
	};
	const terminalPrototype = {
		get rows() {
			return 30;
		},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), {
		columns: 80,
		write() {},
	});
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui = {
		terminal,
		children: [tool],
		previousLines: tool.render(),
		handleInput(data: string) {
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
		},
		requestRender() {
			this.previousLines = tool.render();
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") {
					factory(tui, { fg: (_color: string, text: string) => text });
				}
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputListeners.add(handler);
				return () => inputListeners.delete(handler);
			},
		},
	};

	installToolMouseInteraction(ctx, true);
	tui.handleInput("\x1b[<0;10;2M");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.equal(tool.expanded, false);
	assert.equal(wheelDownDispatches, 1);
	installToolMouseInteraction({}, false);
});

test("disabled fixed editor features release mouse reporting but retain Ctrl+End", () => {
	const writes: string[] = [];
	const widgetValues: unknown[] = [];
	const renderRequests: unknown[] = [];
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const tui = {
		terminal: {
			columns: 80,
			write(value: string) {
				writes.push(value);
			},
		},
		handleInput() {},
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, value: any) {
				widgetValues.push(value);
				if (typeof value === "function") {
					value(tui, { fg: (_color: string, text: string) => text });
				}
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputHandler = handler;
				return () => {
					if (inputHandler === handler) inputHandler = undefined;
				};
			},
		},
	};

	installToolMouseInteraction(ctx, true);
	assert.ok(writes.some((value) => value.includes("?1000h")));
	const disabledWritesStart = writes.length;
	installToolMouseInteraction(ctx, false);
	const disabledWrites = writes.slice(disabledWritesStart);
	assert.ok(disabledWrites.some((value) => value.includes("?1000l")));
	assert.ok(!disabledWrites.some((value) => value.includes("?1000h")));
	assert.equal(typeof widgetValues.at(-1), "function");

	const result = inputHandler?.("\x1b[8^");
	assert.deepEqual(result, { consume: true });
	assert.equal(writes.at(-1), "\x1b[0m");
	assert.deepEqual(renderRequests, [undefined]);

	installToolMouseInteraction({}, false);
});
