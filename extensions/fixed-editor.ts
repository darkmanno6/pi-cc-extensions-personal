import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

type LifecycleHandler = (event: any, ctx: any) => void;
type FixedEditorExtension = (pi: ExtensionAPI) => void;

// The npm package publishes TypeScript source only, so use Pi's own TS loader.
const jiti = createJiti(import.meta.url);
// Match pi-fixed-editor's own `.js` import specifier; Jiti caches `.ts` separately.
const terminalSplit = jiti("@tifan/pi-fixed-editor/src/terminal-split.js") as {
	TerminalSplitCompositor?: { prototype: Record<PropertyKey, any> };
};
export type FixedEditorHitbox = { row: number; startCol: number; endCol: number };

type FixedEditorSharedState = { scrollButtonHitbox: FixedEditorHitbox | null };
const FIXED_EDITOR_STATE_KEY = Symbol.for("pi.ccstyle.fixed-editor.state");
const fixedEditorState = (() => {
	const host = globalThis as typeof globalThis & {
		[FIXED_EDITOR_STATE_KEY]?: FixedEditorSharedState;
	};
	host[FIXED_EDITOR_STATE_KEY] ??= { scrollButtonHitbox: null };
	return host[FIXED_EDITOR_STATE_KEY];
})();

export function getFixedEditorScrollButtonHitbox(): FixedEditorHitbox | null {
	return fixedEditorState.scrollButtonHitbox;
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
	if (prototype[IME_CURSOR_PATCH]) return;
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

if (terminalSplit.TerminalSplitCompositor) {
	installFixedEditorImePatch(terminalSplit.TerminalSplitCompositor);
}

export type FixedEditorController = {
	setEnabled(enabled: boolean): void;
};

type FixedEditorOwner = {
	owner: object;
	stop: () => void;
};

const FIXED_EDITOR_OWNER = Symbol.for("pi.ccstyle.fixed-editor-owner");

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

	const deactivate = () => {
		fixedEditorState.scrollButtonHitbox = null;
		const current = (globalThis as any)[FIXED_EDITOR_OWNER] as FixedEditorOwner | undefined;
		if (current?.owner === owner) current.stop();
		else active = false;
	};
	const activate = () => {
		if (!session || session.ctx?.mode !== "tui" || active) return;
		const previous = (globalThis as any)[FIXED_EDITOR_OWNER] as FixedEditorOwner | undefined;
		if (previous?.owner !== owner) previous?.stop();
		const currentSession = session;
		start?.(currentSession.event, currentSession.ctx);
		active = true;
		(globalThis as any)[FIXED_EDITOR_OWNER] = {
			owner,
			stop: () => {
				if (!active) return;
				shutdown?.(currentSession.event, currentSession.ctx);
				active = false;
				if ((globalThis as any)[FIXED_EDITOR_OWNER]?.owner === owner) {
					delete (globalThis as any)[FIXED_EDITOR_OWNER];
				}
			},
		} satisfies FixedEditorOwner;
	};

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
	};
}
