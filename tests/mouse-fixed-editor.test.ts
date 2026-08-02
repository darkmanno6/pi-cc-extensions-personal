import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import claudeCodeStyleExtension, {
	ExpandedToolIoView,
	fixedEditorWheelDispatchCount,
	installToolMouseInteraction,
	SHOW_MORE_LABEL,
} from "../extensions/claude-code-style.ts";
import { getFixedEditorScrollButtonHitbox } from "../extensions/fixed-editor.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/tool-grouping.ts";

initTheme("dark");

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
		renderCalls: 0,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
			this.renderCalls++;
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
	const above = {
		children: [] as any[],
		render(width: number) {
			return ["", ...this.children.flatMap((child) => child.render(width))];
		},
	};
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
				this.previousLines = [
					"",
					"✓ Bash(echo old)",
					"  └ 1 line output (ctrl+o expand / click)",
					"status",
					"editor",
					"below",
					"footer",
				];
			} else if (data === "\x1b[6~" && transcript.children.length > 0) {
				this.previousLines = [
					"",
					"✓ Bash(echo ok)",
					"  └ 1 line output (ctrl+o expand / click)",
					"status",
					"editor",
					"below",
					"footer",
				];
			}
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const buttonForegrounds: string[] = [];
	const ui = {
		setStatus() {},
		setWidget(_key: string, factory: any) {
			if (!factory) return;
			scrollButton = factory(tui, {
				fg: (color: string, text: string) => {
					buttonForegrounds.push(color);
					return text;
				},
			});
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
	const offscreenRendersBeforeMotion = offscreenTool.renderCalls;
	const visibleRendersBeforeMotion = visibleTool.renderCalls;
	tui.handleInput("\x1b[<35;20;3M");
	assert.equal(offscreenTool.renderCalls - offscreenRendersBeforeMotion, 1);
	assert.equal(visibleTool.renderCalls - visibleRendersBeforeMotion, 1);
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
	assert.doesNotMatch(scrollButton.render(80)[0], /click/i);

	// The Todo panel is registered after ccstyle, so it renders below the button.
	above.children.push({
		render: () => [" Todos (0/3)", " ├─ Todo 1", " ├─ Todo 2", " └─ Todo 3"],
	});
	const cluster = createJiti(import.meta.url)("@tifan/pi-fixed-editor/src/cluster.js") as {
		renderFixedEditorCluster(input: any): unknown;
	};
	const renderCluster = () =>
		cluster.renderFixedEditorCluster({
			width: 80,
			terminalRows: 30,
			statusLines: ["status"],
			aboveWidgetLines: above.render(80).filter((line) => visibleWidth(line) > 0),
			editorLines: ["editor"],
			belowWidgetLines: ["below"],
			footerLines: ["footer"],
		});
	renderCluster();
	const hitbox = getFixedEditorScrollButtonHitbox();
	assert.ok(hitbox);
	const buttonCol = Math.floor((hitbox.startCol + hitbox.endCol) / 2);
	// Hover stays exact so the adjacent Todo row is not highlighted as the button.
	tui.handleInput(`\x1b[<35;${buttonCol};${hitbox.row}M`);
	scrollButton.render(80);
	assert.equal(buttonForegrounds.at(-1), "text");
	tui.handleInput(`\x1b[<35;${buttonCol};${hitbox.row + 1}M`);
	scrollButton.render(80);
	assert.equal(buttonForegrounds.at(-1), "accent");
	// The retained hitbox keeps the visible button clickable when the Todo cluster is present.
	const editorInputsBeforeButton = editorInputCount;
	tui.handleInput(`\x1b[<0;${buttonCol};${hitbox.row}M`);
	assert.deepEqual(scrollButton.render(80), []);
	assert.equal(editorInputCount, editorInputsBeforeButton);

	// Re-open the affordance so the existing PageDown path remains covered.
	tui.handleInput("\x1b[5;9~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	renderCluster();
	assert.match(scrollButton.render(80)[0], /Back to bottom/);
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

test("fixed editor uses the rendered frame when dynamic Todo rows change", () => {
	let firstTitle = "✓ Todo 1";
	let secondTitle = "✓ Todo 3";
	let expandedToolId: string | null = null;
	const createTool = (toolCallId: string, getTitle: () => string) => ({
		toolCallId,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
			return [getTitle(), "  ↳ 1 line returned • click to show more"];
		},
	});
	const first = createTool("todo-1", () => firstTitle);
	const second = createTool("todo-3", () => secondTitle);
	const terminalPrototype = {
		get rows() {
			return 30;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui = {
		terminal,
		children: [first, second],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		doRender() {
			this.previousLines = this.children.flatMap((tool) => tool.render());
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, { fg: (_color: string, text: string) => text });
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		},
		true,
	);
	try {
		tui.doRender();
		assert.equal(tui.previousLines[2], "✓ Todo 3");
		// Dynamic Todo renderers now expose the latest state for both historical components.
		firstTitle = "✓ Todo 3";
		secondTitle = "✓ Todo 3";
		const summaryRow = 4;
		const hintCol = tui.previousLines[summaryRow - 1].indexOf("click to show more") + 1;
		tui.handleInput(`\x1b[<0;${hintCol};${summaryRow}M`);
		assert.equal(expandedToolId, "todo-3");
		assert.equal(first.expanded, false);
		assert.equal(second.expanded, true);
	} finally {
		installToolMouseInteraction({}, false);
	}
});

test("tool groups expand from their hint and collapse from any expanded group row", () => {
	const grouping = installToolGrouping(() => true);
	grouping.setTheme({
		fg: (color: string, text: string) => (color === "text" ? `\x1b[37m${text}\x1b[39m` : text),
	});
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	try {
		const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;
		const parent = new Container() as any;
		for (const [name, id] of [
			["read", "one"],
			["bash", "two"],
		] as const) {
			const component = new ToolExecutionComponent(
				name,
				id,
				{},
				{},
				undefined,
				ui,
				process.cwd(),
			) as any;
			component.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false });
			parent.addChild(component);
		}
		const group = parent.children[0] as any;
		assert.ok(group instanceof ToolGroupComponent);
		const tui = {
			terminal: { columns: 100, write() {} },
			children: [parent],
			previousLines: group.render(100),
			previousViewportTop: 0,
			requestRender() {},
		};
		installToolMouseInteraction(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					setWidget(_key: string, factory: any) {
						factory?.(tui, ui.theme);
					},
					onTerminalInput(handler: typeof inputHandler) {
						inputHandler = handler;
						return () => undefined;
					},
				},
			},
			false,
		);
		const headerRow = tui.previousLines.findIndex((line: string) =>
			line.includes("click to show more"),
		);
		assert.ok(headerRow >= 0);
		const hintColumn = tui.previousLines[headerRow].indexOf("click to show more") + 1;
		inputHandler?.(`\x1b[<32;${hintColumn};${headerRow + 1}M`);
		assert.match(group.render(100)[headerRow], /\x1b\[37m• click to show more\x1b\[39m/);
		assert.equal(inputHandler?.(`\x1b[<0;${hintColumn};${headerRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, true);

		tui.previousLines = group.render(100);
		const bottomPaddingRow = tui.previousLines.length - 1;
		assert.equal(tui.previousLines[bottomPaddingRow].trim(), "");
		assert.equal(inputHandler?.(`\x1b[<0;100;${bottomPaddingRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, false);
	} finally {
		installToolMouseInteraction({}, false);
		grouping.shutdown();
	}
});

test("truncated tool summary remains clickable and highlights on hover", async () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const writes: string[] = [];
	let renderRequests = 0;
	let toolRenderCalls = 0;
	const tool = {
		toolCallId: "tool-truncated",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			toolRenderCalls++;
			return ["✓ Agent(task)", "  └ output (23 more lines / click)"];
		},
	};
	const tui = {
		terminal: { columns: 40, write: (value: string) => writes.push(value) },
		children: [tool],
		previousLines: tool.render(),
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {
			renderRequests++;
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function")
						factory(tui, { fg: (_c: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
	);

	toolRenderCalls = 0;
	inputHandler?.("\x1b[<35;20;2M");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.equal(renderRequests, 1, "hover invalidates the summary renderer");
	assert.equal(toolRenderCalls, 1);

	tui.previousLines = ["ordinary transcript row"];
	inputHandler?.("\x1b[<35;20;1M");
	assert.equal(toolRenderCalls, 1, "ordinary motion skips the tool tree");
	assert.equal(renderRequests, 2, "ordinary motion clears the old hover");

	tui.previousLines = ["✓ Agent(task)", "\x1b[31m  └ output (23 more lines / click)\x1b[0m"];
	inputHandler?.("\x1b[<35;20;2M");
	assert.equal(renderRequests, 3, "ANSI summary hints remain hoverable");
	assert.equal(inputHandler?.("\x1b[<0;5;2M"), undefined);
	assert.equal(tool.expanded, false, "summary text and row padding are not clickable");
	assert.deepEqual(inputHandler?.("\x1b[<0;30;2M"), { consume: true });
	assert.equal(tool.expanded, true);

	installToolMouseInteraction({}, false);
});

test("parenthesized rich diff hint highlights and expands on click", async () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renderRequests = 0;
	const tool = {
		toolCallId: "edit-diff",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return ["✓ Edit sample.ts", " … (29 more diff lines • click to show more)"];
		},
	};
	const tui = {
		terminal: { columns: 80, write() {} },
		children: [tool],
		previousLines: tool.render(),
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {
			renderRequests++;
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function")
						factory(tui, { fg: (_color: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
	);
	try {
		inputHandler?.("\x1b[<35;35;2M");
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(renderRequests, 1, "hover requests a repaint for white hint text");
		assert.deepEqual(inputHandler?.("\x1b[<0;35;2M"), { consume: true });
		assert.equal(tool.expanded, true);
	} finally {
		installToolMouseInteraction({}, false);
	}
});

test("show-more hover targets the view rendered in the current frame after compact", () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const theme = {
		fg: (color: string, text: string) => (color === "text" ? `\x1b[97m${text}\x1b[0m` : text),
		bold: (text: string) => text,
	};
	const staleView = new ExpandedToolIoView(theme, "old\ninput", "old\noutput", false, 1, 1);
	const currentView = new ExpandedToolIoView(
		theme,
		"current\ninput",
		"current\noutput",
		false,
		1,
		1,
	);
	const tool = {
		toolCallId: "tool-after-compact",
		expanded: true,
		state: { ccstyleIoView: staleView },
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return ["✓ Tool", ...currentView.render(78)];
		},
	};
	const terminalPrototype = {
		get rows() {
			return 30;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui: any = {
		terminal,
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput(data: string) {
			inputHandler?.(data);
		},
		requestRender() {},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	const interactionCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui, theme);
			},
			onTerminalInput(handler: typeof inputHandler) {
				inputHandler = handler;
				return () => undefined;
			},
		},
	};
	installToolMouseInteraction(interactionCtx, true);
	// fixed-editor can retain the prior doRender wrapper while compact installs a new one.
	const retainedRender = tui.doRender;
	tui.doRender = function (this: any, ...args: any[]) {
		return Reflect.apply(retainedRender, this, args);
	};
	installToolMouseInteraction(interactionCtx, true);
	try {
		tui.doRender();
		const inputHeader = tui.previousLines[1];
		const col = inputHeader.indexOf(SHOW_MORE_LABEL) + 1;
		tui.handleInput(`\x1b[<35;${col};2M`);
		assert.match(currentView.render(78)[0], /\x1b\[97m/);
		assert.doesNotMatch(staleView.render(78)[0], /\x1b\[97m/);
	} finally {
		installToolMouseInteraction({}, false);
	}
});

test("expanded native card collapses on click and preserves the viewport", async () => {
	let wheelDownDispatches = 0;
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	inputListeners.add((data) => {
		if (/^\x1b\[<65;/.test(data)) wheelDownDispatches++;
		return undefined;
	});
	const cardLines = ["✓ Bash(echo ok)", "  │ one", "  │ two", "  │ three", "  │ four", "  │ five"];
	const contentBox = { render: () => cardLines };
	const tool = {
		toolCallId: "tool-expanded",
		expanded: true,
		contentBox,
		children: [{ render: () => [""] }, contentBox],
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return this.expanded
				? ["", ...cardLines]
				: ["", "✓ Bash(echo ok)", "  └ 5 lines (5 more lines / click)"];
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

test("fixed editor renders reassert mouse motion reporting after Zentui button mode", async () => {
	const writes: string[] = [];
	const events = new Map<string, Function>();
	const terminalPrototype = {
		write(value: string) {
			writes.push(value);
		},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80, rows: 25 });
	const tui = {
		terminal,
		handleInput() {},
		doRender() {
			terminal.write("\x1b[?1002h\x1b[?1006h");
		},
		requestRender() {
			this.doRender();
		},
	};
	const ui = {
		setStatus() {},
		requestRender() {},
		setWidget(_key: string, factory: any) {
			if (typeof factory === "function")
				factory(tui, { fg: (_color: string, text: string) => text });
		},
		onTerminalInput() {
			return () => undefined;
		},
	};
	claudeCodeStyleExtension(
		{
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any,
		{ fixedEditorFeatures: true },
	);
	await events.get("session_start")?.({}, { mode: "tui", hasUI: true, ui });
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	for (const reason of ["startup", "reload"]) {
		if (reason === "reload") {
			await events.get("session_start")?.({ reason }, { mode: "tui", hasUI: true, ui });
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		}
		writes.length = 0;
		tui.doRender();
		assert.ok(writes[0]?.includes("?1002h"), `${reason} allows Zentui button mode`);
		assert.ok(writes.at(-1)?.includes("?1003h"), `${reason} restores motion reporting`);
	}
	await events.get("session_shutdown")?.({}, { mode: "tui", hasUI: true, ui });
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
