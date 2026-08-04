import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

initTheme("dark");

// The install hook patched onto TerminalSplitCompositor.prototype survives
// /reload (jiti returns the same class across module instances), so it must
// read a cross-reload global notify slot. These imports emulate the real
// pre/post-reload module instances: the old module patches the shared
// prototype, then a fresh module instance takes over the session.
const feOld = await import("../extensions/fixed-editor.ts?reload-v1");
const feNew = await import("../extensions/fixed-editor.ts?reload-v2");
const ccOld = await import("../extensions/claude-code-style.ts?reload-v1");
const ccNew = await import("../extensions/claude-code-style.ts?reload-v2");
const ccThird = await import("../extensions/claude-code-style.ts?reload-v3");

test("reload: surviving compositor install hook still binds mouse capture and scroll button clicks", async () => {
	class SnapshotCompositor {
		tui: any;
		installed = false;
		disposed = false;
		terminal: any;
		originalDoRender: any;
		originalRows: any;
		constructor(tui: any, terminal: any) {
			this.tui = tui;
			this.terminal = terminal;
		}
		renderScrollableRoot() {
			return this.tui.previousLines;
		}
		install() {
			if (this.installed) return;
			// Mirrors pi-fixed-editor: patch terminal rows + capture the doRender chain.
			const descriptor = Object.getOwnPropertyDescriptor(this.terminal, "rows");
			this.originalRows = descriptor;
			Object.defineProperty(this.terminal, "rows", {
				configurable: true,
				get: () => 25,
			});
			this.originalDoRender = this.tui.doRender.bind(this.tui);
			this.tui.doRender = () => this.originalDoRender?.();
			this.installed = true;
		}
		dispose() {
			if (this.disposed) return;
			this.disposed = true;
			this.tui.doRender = this.originalDoRender;
			if (this.originalRows) {
				Object.defineProperty(this.terminal, "rows", this.originalRows);
			} else {
				Reflect.deleteProperty(this.terminal, "rows");
			}
		}
	}
	// Old module patches the shared prototype; the reloaded module must not re-patch.
	feOld.installFixedEditorImePatch(SnapshotCompositor as any);

	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let editorInputCount = 0;
	const createTool = (title: string) => ({
		toolCallId: "tool-" + title,
		expanded: false,
		setExpanded() {},
		invalidate() {},
		render: () => ["", `✓ Bash(${title})`, "  └ 1 line output (ctrl+o expand / click)"],
	});
	const offscreenTool = createTool("echo old");
	const visibleTool = createTool("echo ok");
	const transcriptChildren = [offscreenTool, visibleTool];
	const transcript = {
		children: transcriptChildren,
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
	const above = {
		children: [] as any[],
		render(width: number) {
			return ["", ...this.children.flatMap((child) => child.render(width))];
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

	const tui = {
		terminal,
		children: [
			transcript,
			{ render: () => ["status"] },
			above,
			{ children: [editor], render: () => ["editor"] },
			{ render: () => ["below"] },
			{ render: () => ["footer"] },
		],
		focusedComponent: editor,
		previousLines: ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"],
		previousViewportTop: 17,
		requestRender() {},
		render(width: number) {
			return transcript.children.flatMap((child: any) => child.render(width)).slice(-3);
		},
		doRender() {
			this.previousLines = this.render(80);
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
			}
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const originalHandle = tui.handleInput;
	let scrollButton: any;
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
	const makePi = () => {
		const listeners = new Map<string, Set<(...args: any[]) => any>>();
		return {
			pi: {
				registerCommand() {},
				registerShortcut() {},
				registerTool() {},
				on(name: string, handler: (...args: any[]) => any) {
					if (!listeners.has(name)) listeners.set(name, new Set());
					listeners.get(name)!.add(handler);
				},
			},
			async fire(name: string, ...args: any[]) {
				for (const handler of listeners.get(name) ?? []) await handler(...args);
			},
		};
	};
	const ctx = { mode: "tui", hasUI: true, ui };

	// ---- Startup: old module instance owns the session ----
	const oldPi = makePi();
	ccOld.default(oldPi.pi as any, { fixedEditorFeatures: true });
	await oldPi.fire("session_start", { reason: "startup" }, ctx);
	// Compositor installs synchronously via probe render; emulate it.
	const compositorOld = new SnapshotCompositor(tui, terminal);
	compositorOld.install();
	assert.notEqual(tui.handleInput, originalHandle, "startup binds mouse input capture");

	// ---- /reload: old instance shuts down ----
	await oldPi.fire("session_shutdown", { reason: "reload" }, ctx);
	compositorOld.dispose();
	assert.equal(tui.handleInput, originalHandle, "shutdown restores the raw input dispatcher");

	// ---- Reloaded: fresh module instance takes over ----
	const newPi = makePi();
	ccNew.default(newPi.pi as any, { fixedEditorFeatures: true });
	await newPi.fire("session_start", { reason: "reload" }, ctx);
	const compositorNew = new SnapshotCompositor(tui, terminal);
	compositorNew.install();
	// Regression: the surviving prototype hook must notify the *new* owner;
	// otherwise onRebuild never fires and handleInput stays unwrapped.
	assert.notEqual(tui.handleInput, originalHandle, "reload rebinds mouse input capture");

	// The scroll affordance must work after reload: scroll up, then click it.
	tui.handleInput("\x1b[5;9~"); // PageUp
	await new Promise<void>((resolve) => process.nextTick(resolve));
	const cluster = createJiti(import.meta.url)("@tifan/pi-fixed-editor/src/cluster.js") as {
		renderFixedEditorCluster(input: any): unknown;
	};
	cluster.renderFixedEditorCluster({
		width: 80,
		terminalRows: 30,
		statusLines: ["status"],
		aboveWidgetLines: above.render(80).filter((line) => visibleWidth(line) > 0),
		editorLines: ["editor"],
		belowWidgetLines: ["below"],
		footerLines: ["footer"],
	});
	tui.doRender();
	const hitbox = feNew.getFixedEditorScrollButtonHitbox();
	assert.ok(hitbox, "scroll button hitbox computed after reload");
	const buttonCol = Math.floor((hitbox.startCol + hitbox.endCol) / 2);
	assert.match(scrollButton.render(80)[0], /Back to bottom/);
	const editorInputsBeforeClick = editorInputCount;
	tui.handleInput(`\x1b[<0;${buttonCol};${hitbox.row}M`);
	assert.deepEqual(scrollButton.render(80), [], "clicking the button hides it");
	assert.equal(editorInputCount, editorInputsBeforeClick, "button click must not submit input");

	// Cleanup: reloaded owner shuts down and unbinds again.
	await newPi.fire("session_shutdown", { reason: "quit" }, ctx);
	compositorNew.dispose();
	assert.equal(tui.handleInput, originalHandle, "reloaded shutdown restores the raw dispatcher");
});

test("second reload: wrapper chain stays single-layered and clicks keep working", async () => {
	class SnapshotCompositor {
		tui: any;
		installed = false;
		disposed = false;
		terminal: any;
		originalDoRender: any;
		originalRows: any;
		constructor(tui: any, terminal: any) {
			this.tui = tui;
			this.terminal = terminal;
		}
		renderScrollableRoot() {
			return this.tui.previousLines;
		}
		install() {
			if (this.installed) return;
			const descriptor = Object.getOwnPropertyDescriptor(this.terminal, "rows");
			this.originalRows = descriptor;
			Object.defineProperty(this.terminal, "rows", {
				configurable: true,
				get: () => 25,
			});
			this.originalDoRender = this.tui.doRender.bind(this.tui);
			this.tui.doRender = () => this.originalDoRender?.();
			this.installed = true;
		}
		dispose() {
			if (this.disposed) return;
			this.disposed = true;
			this.tui.doRender = this.originalDoRender;
			if (this.originalRows) {
				Object.defineProperty(this.terminal, "rows", this.originalRows);
			} else {
				Reflect.deleteProperty(this.terminal, "rows");
			}
		}
	}

	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let editorInputCount = 0;
	const createTool = (title: string) => ({
		toolCallId: "tool-" + title,
		expanded: false,
		setExpanded() {},
		invalidate() {},
		render: () => ["", `✓ Bash(${title})`, "  └ 1 line output (ctrl+o expand / click)"],
	});
	const offscreenTool = createTool("echo old");
	const visibleTool = createTool("echo ok");
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
	const above = {
		children: [] as any[],
		render(width: number) {
			return ["", ...this.children.flatMap((child) => child.render(width))];
		},
	};
	const terminal = Object.assign(
		Object.create({
			get rows() {
				return 30;
			},
		}),
		{
			columns: 80,
			write() {},
		},
	);
	const tui = {
		terminal,
		children: [
			transcript,
			{ render: () => ["status"] },
			above,
			{ children: [editor], render: () => ["editor"] },
			{ render: () => ["below"] },
			{ render: () => ["footer"] },
		],
		focusedComponent: editor,
		previousLines: ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"],
		previousViewportTop: 17,
		requestRender() {},
		render(width: number) {
			return transcript.children.flatMap((child: any) => child.render(width)).slice(-3);
		},
		doRender() {
			this.previousLines = this.render(80);
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
			}
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const originalHandle = tui.handleInput;
	let scrollButton: any;
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
	const ctx = { mode: "tui", hasUI: true, ui };
	const makePi = () => {
		const listeners = new Map<string, Set<(...args: any[]) => any>>();
		return {
			pi: {
				registerCommand() {},
				registerShortcut() {},
				registerTool() {},
				on(name: string, handler: (...args: any[]) => any) {
					if (!listeners.has(name)) listeners.set(name, new Set());
					listeners.get(name)!.add(handler);
				},
			},
			async fire(name: string, ...args: any[]) {
				for (const handler of listeners.get(name) ?? []) await handler(...args);
			},
		};
	};

	// Startup with the pre-reload module, then two reloads.
	const firstPi = makePi();
	feOld.installFixedEditorImePatch(SnapshotCompositor as any);
	ccOld.default(firstPi.pi as any, { fixedEditorFeatures: true });
	await firstPi.fire("session_start", { reason: "startup" }, ctx);
	const compositorFirst = new SnapshotCompositor(tui, terminal);
	compositorFirst.install();
	assert.notEqual(tui.handleInput, originalHandle, "startup binds capture");

	await firstPi.fire("session_shutdown", { reason: "reload" }, ctx);
	compositorFirst.dispose();
	const secondPi = makePi();
	ccNew.default(secondPi.pi as any, { fixedEditorFeatures: true });
	await secondPi.fire("session_start", { reason: "reload" }, ctx);
	const compositorSecond = new SnapshotCompositor(tui, terminal);
	compositorSecond.install();
	assert.notEqual(tui.handleInput, originalHandle, "first reload rebinds capture");

	await secondPi.fire("session_shutdown", { reason: "reload" }, ctx);
	compositorSecond.dispose();
	const thirdPi = makePi();
	ccThird.default(thirdPi.pi as any, { fixedEditorFeatures: true });
	await thirdPi.fire("session_start", { reason: "reload" }, ctx);
	const compositorThird = new SnapshotCompositor(tui, terminal);
	compositorThird.install();
	assert.notEqual(tui.handleInput, originalHandle, "second reload rebinds capture");

	// Scroll button click still lands after two reloads.
	tui.handleInput("\x1b[5;9~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	const cluster = createJiti(import.meta.url)("@tifan/pi-fixed-editor/src/cluster.js") as {
		renderFixedEditorCluster(input: any): unknown;
	};
	cluster.renderFixedEditorCluster({
		width: 80,
		terminalRows: 30,
		statusLines: ["status"],
		aboveWidgetLines: above.render(80).filter((line) => visibleWidth(line) > 0),
		editorLines: ["editor"],
		belowWidgetLines: ["below"],
		footerLines: ["footer"],
	});
	tui.doRender();
	const hitbox = feNew.getFixedEditorScrollButtonHitbox();
	assert.ok(hitbox, "scroll button hitbox computed after two reloads");
	const buttonCol = Math.floor((hitbox.startCol + hitbox.endCol) / 2);
	assert.match(scrollButton.render(80)[0], /Back to bottom/);
	const editorInputsBeforeClick = editorInputCount;
	tui.handleInput(`\x1b[<0;${buttonCol};${hitbox.row}M`);
	assert.deepEqual(scrollButton.render(80), [], "clicking the button hides it");
	assert.equal(editorInputCount, editorInputsBeforeClick, "button click must not submit input");

	await thirdPi.fire("session_shutdown", { reason: "quit" }, ctx);
	compositorThird.dispose();
	assert.equal(tui.handleInput, originalHandle, "final shutdown restores the raw dispatcher");
});
