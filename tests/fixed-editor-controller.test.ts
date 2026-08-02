import assert from "node:assert/strict";
import test from "node:test";

import { installFixedEditor, installFixedEditorImePatch } from "../extensions/fixed-editor.ts";

function runtime(initiallyEnabled: boolean) {
	const events = new Map<string, Function>();
	const widgets: unknown[] = [];
	const controller = installFixedEditor(
		{
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any,
		initiallyEnabled,
	);
	const ctx = {
		mode: "tui",
		ui: {
			setWidget(_key: string, value: unknown) {
				widgets.push(value);
			},
		},
	};
	return { controller, ctx, events, widgets };
}

function muteTerminalReset(run: () => void): void {
	const write = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		run();
	} finally {
		process.stdout.write = write;
	}
}

test("hidden hardware cursor stays at the fixed editor for IME composition", () => {
	class FakeCompositor {
		writes: string[] = [];
		showHardwareCursor = false;
		terminal = { columns: 80 };
		disposed = false;
		originalWrite = (data: string) => this.writes.push(data);
		getShowHardwareCursor = () => this.showHardwareCursor;
		hasVisibleOverlay = () => false;
		getRawRows = () => 20;
		getCluster = () => ({
			lines: ["status", "editor", "below", "footer"],
			cursor: { row: 1, col: 2 },
		});
		requestRepaint() {}
		write() {}
	}
	installFixedEditorImePatch(FakeCompositor as any);
	const compositor = new FakeCompositor();

	compositor.requestRepaint();
	assert.equal(compositor.writes.at(-1), "\x1b[?2026h\x1b[18;3H\x1b[?25l\x1b[?2026l");

	compositor.showHardwareCursor = true;
	const count = compositor.writes.length;
	compositor.write();
	assert.equal(compositor.writes.length, count);
});

test("npm fixed editor applies IME positioning and widget spacing patches", async () => {
	const { ctx, events, widgets } = runtime(true);
	const writes: string[] = [];
	const component = (line: string, children: any[] = []) => ({
		children,
		render: (width: number) =>
			children.length > 0 ? children.flatMap((child) => child.render(width)) : [line],
		invalidate() {},
	});
	const editor = {
		focused: true,
		getText() {
			return "";
		},
		setText() {},
		handleInput() {},
		render: () => [`editor\x1b_pi:c\x07`],
		invalidate() {},
	};
	const tui: any = {
		children: [
			component("status"),
			component("above"),
			component("", [editor]),
			component("below"),
			component("footer"),
		],
		focusedComponent: editor,
		terminal: {
			columns: 80,
			rows: 20,
			write(data: string) {
				writes.push(data);
			},
		},
		getShowHardwareCursor: () => false,
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.terminal.write("root");
		},
		addInputListener() {
			return () => {};
		},
		hasOverlay: () => false,
	};

	events.get("session_start")?.({}, ctx);
	const factory = widgets.at(-1) as Function;
	const probe = factory(tui, {});
	probe.render(80);
	await Promise.resolve();
	tui.doRender();

	assert.ok(
		writes.some((data) =>
			data.includes("\x1b[15;1H\x1b[2Kstatus\x1b[16;1H\x1b[2K\x1b[17;1H\x1b[2K above"),
		),
		JSON.stringify(writes),
	);
	assert.ok(writes.some((data) => data.includes("\x1b[19;1H\x1b[2K below")));
	assert.ok(
		writes.some((data) => data.includes("\x1b[18;7H\x1b[?25l")),
		JSON.stringify(writes),
	);
	events.get("session_shutdown")?.({}, ctx);
});

test("fixed editor can be enabled and disabled during a TUI session", () => {
	muteTerminalReset(() => {
		const { controller, ctx, events, widgets } = runtime(false);
		events.get("session_start")?.({}, ctx);
		assert.deepEqual(widgets, []);

		controller.setEnabled(true);
		assert.equal(typeof widgets.at(-1), "function");

		controller.setEnabled(false);
		assert.equal(widgets.at(-1), undefined);
	});
});

test("stale shutdown cannot disable the replacement fixed editor", () => {
	muteTerminalReset(() => {
		const first = runtime(true);
		const second = runtime(true);
		first.events.get("session_start")?.({}, first.ctx);
		second.events.get("session_start")?.({}, second.ctx);
		const count = second.widgets.length;

		first.events.get("session_shutdown")?.({}, first.ctx);
		assert.equal(second.widgets.length, count);
		assert.equal(typeof second.widgets.at(-1), "function");

		second.events.get("session_shutdown")?.({}, second.ctx);
	});
});
