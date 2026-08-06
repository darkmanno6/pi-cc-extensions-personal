import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isFullscreenUi, isLazyProxyTui } from "./fullscreen-detect.ts";
import { createJiti } from "jiti";

type LifecycleHandler = (event: any, ctx: any) => void;
type FixedEditorExtension = (pi: ExtensionAPI) => void;

// Upstream publishes TS only. Nested jiti must reuse Pi's live modules — peer
// deps are not resolvable from ~/.pi/agent/npm/node_modules/pi-cc-extensions.
const jiti = createJiti(import.meta.url, {
	virtualModules: {
		"@earendil-works/pi-coding-agent": piCodingAgent,
		"@earendil-works/pi-tui": piTui,
	},
});
// Match pi-fixed-editor's own `.js` import specifier; Jiti caches `.ts` separately.
const terminalSplit = jiti("@tifan/pi-fixed-editor/src/terminal-split.js") as {
	TerminalSplitCompositor?: { prototype: Record<PropertyKey, any> };
};
export type FixedEditorHitbox = { row: number; startCol: number; endCol: number };
export type FixedEditorViewportSnapshot = {
	tui: object;
	visibleRootStart: number;
	visibleScrollableRows: number;
	visibleLines: readonly string[];
	generation: number;
};

type FixedEditorSharedState = {
	scrollButtonHitbox: FixedEditorHitbox | null;
	viewports: WeakMap<object, FixedEditorViewportSnapshot>;
	generation: number;
};
const FIXED_EDITOR_STATE_KEY = Symbol.for("pi.ccstyle.fixed-editor.state");
const fixedEditorState = (() => {
	const host = globalThis as typeof globalThis & {
		[FIXED_EDITOR_STATE_KEY]?: FixedEditorSharedState;
	};
	const state = (host[FIXED_EDITOR_STATE_KEY] ??= {
		scrollButtonHitbox: null,
		viewports: new WeakMap(),
		generation: 0,
	});
	state.viewports ??= new WeakMap();
	state.generation ??= 0;
	return state;
})();

export function getFixedEditorScrollButtonHitbox(): FixedEditorHitbox | null {
	return fixedEditorState.scrollButtonHitbox;
}

export function getFixedEditorViewport(tui: object): FixedEditorViewportSnapshot | null {
	return fixedEditorState.viewports.get(tui) ?? null;
}

function clearFixedEditorViewport(): void {
	fixedEditorState.viewports = new WeakMap();
}

const FIXED_EDITOR_SPACING_PATCH = Symbol.for("pi.ccstyle.fixed-editor-spacing-patch");
const clusterModule = jiti("@tifan/pi-fixed-editor/src/cluster.js") as {
	renderFixedEditorCluster?: (input: any) => any;
};
if (!(clusterModule as any)[FIXED_EDITOR_SPACING_PATCH] && clusterModule.renderFixedEditorCluster) {
	const renderCluster = clusterModule.renderFixedEditorCluster;
	const padWidgets = (lines: string[] | undefined) =>
		lines?.map((line) => (line.length > 0 && !line.includes("Ctrl+End") ? ` ${line}` : line));
	clusterModule.renderFixedEditorCluster = (input) => {
		const aboveWidgetLines = padWidgets(input.aboveWidgetLines);
		const result = renderCluster({
			...input,
			// pi-fixed-editor strips Pi's leading widget spacer; restore it below the spinner.
			aboveWidgetLines:
				input.statusLines?.length && aboveWidgetLines?.length
					? ["", ...aboveWidgetLines]
					: aboveWidgetLines,
			belowWidgetLines: padWidgets(input.belowWidgetLines),
		});
		const buttonRow = result.lines.findIndex((line: string) => line.includes("Ctrl+End"));
		if (buttonRow < 0) {
			fixedEditorState.scrollButtonHitbox = null;
		} else {
			const plain = result.lines[buttonRow]
				.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
			const start = plain.indexOf("[");
			fixedEditorState.scrollButtonHitbox = {
				row: input.terminalRows - result.lines.length + buttonRow + 1,
				startCol: visibleWidth(plain.slice(0, Math.max(0, start))) + 1,
				endCol: visibleWidth(plain.trimEnd()),
			};
		}
		return result;
	};
	(clusterModule as any)[FIXED_EDITOR_SPACING_PATCH] = true;
}
const loaded = jiti("@tifan/pi-fixed-editor/src/index.ts") as {
	default?: FixedEditorExtension;
};
const fixedEditor = loaded.default ?? (loaded as unknown as FixedEditorExtension);

const IME_CURSOR_PATCH = Symbol.for("pi.ccstyle.fixed-editor-ime-cursor-patch");
const VIEWPORT_PATCH = Symbol.for("pi.ccstyle.fixed-editor-viewport-patch");
const MOUSE_WRITE_PATCH = Symbol.for("pi.ccstyle.fixed-editor-mouse-write-patch");
const MOUSE_WRITE_RESTORE_PATCH = Symbol.for("pi.ccstyle.fixed-editor-mouse-write-restore-patch");

function positionHiddenImeCursor(compositor: any): void {
	if (
		compositor.disposed ||
		compositor.writing ||
		compositor.getShowHardwareCursor?.() ||
		compositor.hasVisibleOverlay?.()
	)
		return;
	const rows = compositor.getRawRows?.();
	if (!Number.isFinite(rows)) return;
	const width = Math.max(1, Number(compositor.terminal?.columns) || 80);
	const cluster = compositor.getCluster?.(width, rows);
	if (!cluster?.cursor) return;
	const row = Math.max(1, rows - cluster.lines.length + cluster.cursor.row + 1);
	const col = Math.max(1, cluster.cursor.col + 1);
	compositor.originalWrite?.(`\x1b[?2026h\x1b[${row};${col}H\x1b[?25l\x1b[?2026l`);
}

export function installFixedEditorImePatch(compositorClass: {
	prototype: Record<PropertyKey, any>;
}): void {
	const prototype = compositorClass.prototype;
	if (!prototype[IME_CURSOR_PATCH]) {
		for (const name of ["write", "requestRepaint"] as const) {
			const original = prototype[name];
			if (typeof original !== "function") continue;
			prototype[name] = function (this: any, ...args: any[]) {
				const result = Reflect.apply(original, this, args);
				positionHiddenImeCursor(this);
				return result;
			};
		}
		prototype[IME_CURSOR_PATCH] = true;
	}
	if (!prototype[VIEWPORT_PATCH] && typeof prototype.renderScrollableRoot === "function") {
		const originalRenderScrollableRoot = prototype.renderScrollableRoot;
		prototype.renderScrollableRoot = function (this: any, ...args: any[]) {
			const lines = Reflect.apply(originalRenderScrollableRoot, this, args);
			if (this.tui && !this.disposed && Array.isArray(lines)) {
				fixedEditorState.viewports.set(this.tui, {
					tui: this.tui,
					visibleRootStart: Number(this.visibleRootStart) || 0,
					visibleScrollableRows: Number(this.visibleScrollableRows) || lines.length,
					visibleLines: [...lines],
					generation: ++fixedEditorState.generation,
				});
			}
			return lines;
		};
		prototype[VIEWPORT_PATCH] = true;
	}
	if (!prototype[MOUSE_WRITE_PATCH] && typeof prototype.install === "function") {
		const originalInstall = prototype.install;
		prototype.install = function (this: any, ...args: any[]) {
			if (!Object.hasOwn(this, MOUSE_WRITE_PATCH) && typeof this.originalWrite === "function") {
				const originalWrite = this.originalWrite;
				this.originalWrite = (data: string) =>
					Reflect.apply(originalWrite, this, [data.replaceAll("\x1b[?1002h", "\x1b[?1003h")]);
				this[MOUSE_WRITE_PATCH] = originalWrite;
			}
			const wasInstalled = Boolean(this.installed);
			const result = Reflect.apply(originalInstall, this, args);
			// Dependents re-wrap doRender only after the compositor actually owns it.
			// Read the global each time: the patch survives /reload on the shared
			// prototype while the owner callback belongs to the live extension module.
			if (!wasInstalled && this.installed && !this.disposed)
				getCompositorInstallNotify()?.callback();
			return result;
		};
		prototype[MOUSE_WRITE_PATCH] = true;
	}
	if (!prototype[MOUSE_WRITE_RESTORE_PATCH] && typeof prototype.dispose === "function") {
		const originalDispose = prototype.dispose;
		prototype.dispose = function (this: any, ...args: any[]) {
			const originalWrite = Object.hasOwn(this, MOUSE_WRITE_PATCH)
				? this[MOUSE_WRITE_PATCH]
				: undefined;
			try {
				return Reflect.apply(originalDispose, this, args);
			} finally {
				if (typeof originalWrite === "function" && this.terminal) {
					this.terminal.write = originalWrite;
				}
			}
		};
		prototype[MOUSE_WRITE_RESTORE_PATCH] = true;
	}
}

const COMPOSITOR_PROXY_GUARD = Symbol.for("pi.ccstyle.compositor-proxy-guard");

if (terminalSplit.TerminalSplitCompositor) {
	installFixedEditorImePatch(terminalSplit.TerminalSplitCompositor);
	// 0.84+ 的 tui 是惰性 Proxy：compositor 构造时捕获的 doRender/render 是
	// 每次重新解析的包装，install 后执行会解析到 compositor 自身（无限递归）。
	// 检测到惰性 Proxy 时跳过安装，渲染管线完全交给官方。
	installProxyGuard(terminalSplit.TerminalSplitCompositor);
}

function installProxyGuard(compositorClass: { prototype: Record<PropertyKey, any> }): void {
	const prototype = compositorClass.prototype;
	const originalInstall = prototype.install;
	if (typeof originalInstall !== "function" || prototype[COMPOSITOR_PROXY_GUARD]) return;
	prototype[COMPOSITOR_PROXY_GUARD] = true;
	prototype.install = function (this: any, ...args: any[]) {
		if (isLazyProxyTui(this.tui)) return;
		return Reflect.apply(originalInstall, this, args);
	};
}

export type FixedEditorController = {
	setEnabled(enabled: boolean): void;
	/** Fires after compositor install/reinstall (session start, enable, footer rebuild). */
	onRebuild(listener: () => void): () => void;
};

type FixedEditorOwner = {
	owner: object;
	stop: () => void;
};

const FIXED_EDITOR_OWNER = Symbol.for("pi.ccstyle.fixed-editor-owner");
const FIXED_EDITOR_FOOTER_HOOK = Symbol.for("pi.ccstyle.fixed-editor-footer-hook");

// /reload keeps the same TerminalSplitCompositor.prototype, so the install hook
// patched by the pre-reload module must read a cross-reload global instead of a
// module-local variable; otherwise notifyRebuild never fires after reload and
// dependents (ccstyle mouse input capture) stay unbound.
const COMPOSITOR_INSTALL_NOTIFY_KEY = Symbol.for("pi.ccstyle.compositor-install-notify");

type CompositorInstallNotify = { owner: object; callback: () => void };
function getCompositorInstallNotify(): CompositorInstallNotify | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[COMPOSITOR_INSTALL_NOTIFY_KEY] as
		| CompositorInstallNotify
		| undefined;
}
function setCompositorInstallNotify(value: CompositorInstallNotify | undefined): void {
	if (value) (globalThis as Record<PropertyKey, unknown>)[COMPOSITOR_INSTALL_NOTIFY_KEY] = value;
	else delete (globalThis as Record<PropertyKey, unknown>)[COMPOSITOR_INSTALL_NOTIFY_KEY];
}
/** Runs before fixed-editor start/probe so dependents can unwrap doRender before capture. */
let beforeFixedEditorStart: (() => void) | undefined;

/** Register a pre-start hook (e.g. unwrap mouse doRender before compositor construction). */
export function setBeforeFixedEditorStart(listener: (() => void) | undefined): void {
	beforeFixedEditorStart = listener;
}

type FooterHookState = { listener?: () => void };

function observeFooterReplacement(ui: any, listener: () => void): () => void {
	let state = ui[FIXED_EDITOR_FOOTER_HOOK] as FooterHookState | undefined;
	if (!state) {
		const original = ui.setFooter;
		state = {};
		const hookState = state;
		ui.setFooter = function (this: unknown, ...args: unknown[]) {
			const result = Reflect.apply(original, this, args);
			hookState.listener?.();
			return result;
		};
		ui[FIXED_EDITOR_FOOTER_HOOK] = state;
	}
	state.listener = listener;
	return () => {
		if (state.listener === listener) state.listener = undefined;
	};
}

/** Adds runtime on/off control around pi-fixed-editor's session lifecycle. */
export function installFixedEditor(
	pi: ExtensionAPI,
	initiallyEnabled: boolean,
): FixedEditorController {
	let start: LifecycleHandler | undefined;
	let shutdown: LifecycleHandler | undefined;
	fixedEditor({
		on(event: string, handler: LifecycleHandler) {
			if (event === "session_start") start = handler;
			if (event === "session_shutdown") shutdown = handler;
		},
	} as unknown as ExtensionAPI);

	const owner = {};
	let enabled = initiallyEnabled;
	let active = false;
	let session: { event: any; ctx: any } | undefined;
	let unobserveFooter: (() => void) | undefined;
	let footerRestartQueued = false;
	const rebuildListeners = new Set<() => void>();
	const notifyRebuild = () => {
		for (const listener of rebuildListeners) listener();
	};

	const unhookFooter = () => {
		unobserveFooter?.();
		unobserveFooter = undefined;
	};
	const hookFooter = () => {
		const ui = session?.ctx?.ui;
		if (typeof ui?.setFooter !== "function") return;
		unobserveFooter = observeFooterReplacement(ui, () => {
			if (!active || footerRestartQueued) return;
			footerRestartQueued = true;
			const currentSession = session;
			queueMicrotask(() => {
				footerRestartQueued = false;
				if (!active || session !== currentSession) return;
				// Dispose old compositor first, then reinstall and rebind dependents.
				deactivate();
				activate();
			});
		});
	};
	function clearInstallNotify() {
		if (getCompositorInstallNotify()?.owner === owner) setCompositorInstallNotify(undefined);
	}
	function deactivate() {
		fixedEditorState.scrollButtonHitbox = null;
		clearFixedEditorViewport();
		const current = (globalThis as any)[FIXED_EDITOR_OWNER] as FixedEditorOwner | undefined;
		if (current?.owner === owner) current.stop();
		else {
			clearInstallNotify();
			unhookFooter();
			active = false;
		}
	}
	function activate() {
		if (!session || session.ctx?.mode !== "tui" || active) return;
		// fullscreen 复用官方的 sticky editor，固定编辑器让位
		if (isFullscreenUi(session.ctx)) return;
		const previous = (globalThis as any)[FIXED_EDITOR_OWNER] as FixedEditorOwner | undefined;
		if (previous?.owner !== owner) previous?.stop();
		const currentSession = session;
		// Register before start/probe so the first real compositor.install notifies us.
		setCompositorInstallNotify({
			owner,
			callback: () => {
				if (!active) return;
				if ((globalThis as any)[FIXED_EDITOR_OWNER]?.owner !== owner) return;
				notifyRebuild();
			},
		});
		// Unwrap outer doRender patches before compositor construction captures it.
		beforeFixedEditorStart?.();
		start?.(currentSession.event, currentSession.ctx);
		active = true;
		hookFooter();
		(globalThis as any)[FIXED_EDITOR_OWNER] = {
			owner,
			stop: () => {
				if (!active) return;
				clearInstallNotify();
				unhookFooter();
				clearFixedEditorViewport();
				shutdown?.(currentSession.event, currentSession.ctx);
				active = false;
				if ((globalThis as any)[FIXED_EDITOR_OWNER]?.owner === owner) {
					delete (globalThis as any)[FIXED_EDITOR_OWNER];
				}
			},
		} satisfies FixedEditorOwner;
	}

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		if (enabled) activate();
	});
	pi.on("session_shutdown", () => {
		deactivate();
		session = undefined;
	});

	return {
		setEnabled(nextEnabled) {
			enabled = nextEnabled;
			if (nextEnabled) activate();
			else deactivate();
		},
		onRebuild(listener) {
			rebuildListeners.add(listener);
			return () => {
				rebuildListeners.delete(listener);
			};
		},
	};
}
