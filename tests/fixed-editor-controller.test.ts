import assert from "node:assert/strict";
import test from "node:test";

import {
	getFixedEditorViewport,
	installFixedEditor,
	installFixedEditorImePatch,
} from "../extensions/fixed-editor.ts";

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
			setFooter() {},
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
	tui.render(80);
	tui.doRender();

	const viewport = getFixedEditorViewport(tui);
	assert.ok(viewport);
	assert.equal(viewport.tui, tui);
	assert.equal(viewport.visibleLines.length, viewport.visibleScrollableRows);
	assert.ok(viewport.generation > 0);
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
	assert.equal(getFixedEditorViewport(tui), null);
});

test("fixed editor can be enabled and disabled during a TUI session", () => {
	muteTerminalReset(() => {
		const { controller, ctx, events, widgets } = runtime(false);
		events.get("session_start")?.({}, ctx);
		assert.deepEqual(widgets, []);

		controller.setEnabled(true);
		assert.equal(typeof widgets.at(-1), "function");
		const footerHook = ctx.ui.setFooter;

		controller.setEnabled(false);
		assert.equal(widgets.at(-1), undefined);
		controller.setEnabled(true);
		assert.equal(ctx.ui.setFooter, footerHook);
		controller.setEnabled(false);
	});
});

test("footer replacement reprobes the fixed editor cluster", async () => {
	const write = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		const { ctx, events, widgets } = runtime(true);
		events.get("session_start")?.({}, ctx);
		const firstFactory = widgets.at(-1);

		ctx.ui.setFooter();
		await Promise.resolve();

		assert.equal(widgets.at(-2), undefined);
		assert.equal(typeof widgets.at(-1), "function");
		assert.notEqual(widgets.at(-1), firstFactory);

		ctx.ui.setFooter();
		events.get("session_shutdown")?.({}, ctx);
		const widgetCount = widgets.length;
		await Promise.resolve();
		assert.equal(widgets.length, widgetCount);
	} finally {
		process.stdout.write = write;
	}
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

async function installProbe(widgets: unknown[], tui: any): Promise<void> {
	const factory = widgets.at(-1) as Function | undefined;
	assert.equal(typeof factory, "function");
	const probe = factory!(tui, {});
	probe.render(80);
	await Promise.resolve();
}

test("footer rebuild notifies onRebuild after compositor reinstall", async () => {
	const write = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		const { controller, ctx, events, widgets } = runtime(true);
		let rebuilds = 0;
		controller.onRebuild(() => {
			rebuilds++;
		});
		const editor = {
			focused: true,
			getText: () => "",
			setText() {},
			handleInput() {},
			render: () => [`editor\x1b_pi:c\x07`],
			invalidate() {},
		};
		const component = (line: string, children: any[] = []) => ({
			children,
			render: (width: number) =>
				children.length > 0 ? children.flatMap((child) => child.render(width)) : [line],
			invalidate() {},
		});
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
				write() {},
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
		assert.equal(rebuilds, 0, "activate alone does not notify before install");
		await installProbe(widgets, tui);
		assert.equal(rebuilds, 1, "compositor install notifies rebuild");

		ctx.ui.setFooter();
		await Promise.resolve();
		assert.equal(rebuilds, 1, "footer queues reinstall without premature notify");
		await installProbe(widgets, tui);
		assert.equal(rebuilds, 2, "footer replacement notifies after real reinstall");

		events.get("session_shutdown")?.({}, ctx);
	} finally {
		process.stdout.write = write;
	}
});
