import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getSettingsListTheme,
	keyHint,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	installCompactStyle,
	type CompactStyleHooks,
	type CompactStyleMode,
} from "./compact-style.ts";
import { showTextPreview } from "./context.ts";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	installWriteOverride,
	renderRichToolResult,
	WriteExecutionMetadataStore,
	type DiffIndicatorMode,
	type DiffViewMode,
	type ToolDisplayConfig,
} from "./tool-diff/index.ts";
import {
	SettingsList,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code Style for pi.
 *
 * This is the package's only entry point. Compact transcript rendering lives in
 * the internal compact-style module and is routed by the mode below.
 */

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	fixedEditorFeatures: boolean;
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "claude-code-style.json");

const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
const DIFF_COLLAPSED_LINES_VALUES = ["12", "24", "36", "48", "80", "120"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
/** Tools commonly toggled in excludeRenderers via the settings panel. */
const EXCLUDE_RENDERER_CANDIDATES = [
	"bash",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"webfetch",
	"wait",
];

export const DEFAULT_CONFIG: Config = {
	mode: "on",
	excludeRenderers: [],
	fixedEditorFeatures: true,
	diffViewMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode,
	diffIndicatorMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode,
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	diffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
};

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function pickPositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

function nearestPreset(value: number, presets: readonly string[]): string {
	const numeric = presets.map((p) => Number(p));
	let best = presets[0] ?? String(value);
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < numeric.length; i++) {
		const dist = Math.abs((numeric[i] ?? 0) - value);
		if (dist < bestDist) {
			bestDist = dist;
			best = presets[i] ?? best;
		}
	}
	// Prefer exact match when value is already a preset.
	const exact = presets.find((p) => Number(p) === value);
	return exact ?? best;
}

export function normalizeConfig(input: unknown): Config {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const mode = source.mode;
	const migratedMode: CompactStyleMode =
		mode === "on" || mode === "off" || mode === "compact"
			? mode
			: typeof source.enabled === "boolean"
				? source.enabled
					? "on"
					: "off"
				: "on";
	const excludeRenderers = Array.isArray(source.excludeRenderers)
		? [
				...new Set(
					source.excludeRenderers.filter(
						(name): name is string => typeof name === "string" && name.length > 0,
					),
				),
			]
		: [];
	const fixedEditorFeatures = source.fixedEditorFeatures !== false;
	return {
		mode: migratedMode,
		excludeRenderers,
		fixedEditorFeatures,
		diffViewMode: pickEnum(source.diffViewMode, DIFF_VIEW_MODES, DEFAULT_CONFIG.diffViewMode),
		diffIndicatorMode: pickEnum(
			source.diffIndicatorMode,
			DIFF_INDICATOR_MODES,
			DEFAULT_CONFIG.diffIndicatorMode,
		),
		diffSplitMinWidth: pickPositiveInt(
			source.diffSplitMinWidth,
			DEFAULT_CONFIG.diffSplitMinWidth,
			40,
			300,
		),
		diffCollapsedLines: pickPositiveInt(
			source.diffCollapsedLines,
			DEFAULT_CONFIG.diffCollapsedLines,
			1,
			500,
		),
		diffWordWrap: source.diffWordWrap !== false,
		expandedPreviewMaxLines: pickPositiveInt(
			source.expandedPreviewMaxLines,
			DEFAULT_CONFIG.expandedPreviewMaxLines,
			10,
			50_000,
		),
	};
}

export function getToolDisplayConfig(source: Config = config): ToolDisplayConfig {
	return {
		diffViewMode: source.diffViewMode,
		diffIndicatorMode: source.diffIndicatorMode,
		diffSplitMinWidth: source.diffSplitMinWidth,
		diffCollapsedLines: source.diffCollapsedLines,
		diffWordWrap: source.diffWordWrap,
		expandedPreviewMaxLines: source.expandedPreviewMaxLines,
	};
}

function formatExcludeRenderers(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

export function formatConfigStatus(source: Config = config): string {
	return [
		`mode=${source.mode}`,
		`fixedEditor=${source.fixedEditorFeatures ? "on" : "off"}`,
		`exclude=[${source.excludeRenderers.join(", ") || "none"}]`,
		`diffView=${source.diffViewMode}`,
		`diffIndicator=${source.diffIndicatorMode}`,
		`diffSplitMin=${source.diffSplitMinWidth}`,
		`diffCollapsed=${source.diffCollapsedLines}`,
		`diffWordWrap=${source.diffWordWrap ? "on" : "off"}`,
		`expandedMax=${source.expandedPreviewMaxLines}`,
	].join(" · ");
}

let config: Config = loadConfig();

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown;
			const normalized = normalizeConfig(parsed);
			const source = parsed as Record<string, unknown>;
			// Persist the one-time enabled:boolean -> mode migration while retaining
			// the existing exclusion list.
			if (
				typeof source.enabled === "boolean" &&
				source.mode !== "on" &&
				source.mode !== "off" &&
				source.mode !== "compact"
			) {
				try {
					writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
				} catch {
					// A read-only config still uses the migrated in-memory value.
				}
			}
			return normalized;
		}
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function oneLine(value: unknown, max = 72): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textFromResult(result: any): string {
	const item = result?.content?.find?.((c: any) => c.type === "text");
	// Compact previews only need line counts / short text; bound sanitize work.
	return item?.type === "text" ? sanitizeToolResultText(item.text ?? "", 16_384) : "";
}

function countLines(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
	return countLines(text) > 1;
}

function toolIcon(_name: string): string {
	return "●";
}

// Match the braille loader shown to the left of pi's "Working..." row.
// Every frame is one cell wide, so tool titles remain horizontally stable.
const WORKING_LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_PENDING_FRAMES: Record<string, string[]> = {
	read: WORKING_LOADER_FRAMES,
	bash: WORKING_LOADER_FRAMES,
	edit: WORKING_LOADER_FRAMES,
	write: WORKING_LOADER_FRAMES,
	find: WORKING_LOADER_FRAMES,
	grep: WORKING_LOADER_FRAMES,
	ls: WORKING_LOADER_FRAMES,
};

function animationFrame(frames: string[], intervalMs = 120): string {
	return frames[Math.floor(Date.now() / intervalMs) % frames.length] ?? frames[0] ?? "";
}

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function scheduleAnimation(context: any, intervalMs = 80) {
	const state = (context.state ??= {});
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				ctx.invalidate?.();
			}
		}, intervalMs);
	}
}

function pendingIcon(name: string): string {
	return animationFrame(TOOL_PENDING_FRAMES[name] ?? [toolIcon(name)], 80);
}

type ToolVisualState = "pending" | "success" | "error";

function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	return toolIcon(name);
}

function setToolVisualState(context: any, visualState: ToolVisualState) {
	const state = (context.state ??= {});
	if (visualState !== "pending") clearAnimation(context);
	if (state.ccstyleToolVisualState === visualState) return;
	state.ccstyleToolVisualState = visualState;
	// Do not invalidate synchronously from renderResult. Pi is already rendering
	// this tool row; recursively scheduling another render here can retain both
	// the finalized result component and its previous secondary/partial component,
	// which displays the result summary twice. The current render pass also
	// refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: any): ToolVisualState | undefined {
	return context?.state?.ccstyleToolVisualState as ToolVisualState | undefined;
}

function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

function isToolExpanded(options: any, context: any): boolean {
	const local = context?.state?.ccstyleToolExpanded;
	return typeof local === "boolean" ? local : Boolean(options?.expanded ?? context?.expanded);
}

/** Keep the guide aligned when long result lines wrap at the viewport edge. */
export class ExpandedToolResultText {
	private text: string;
	private prefix: string;
	private normalizedText: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
		this.invalidate();
	}

	setPrefix(prefix: string): void {
		if (this.prefix === prefix) return;
		this.prefix = prefix;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const lines = wrapTextWithAnsi(this.normalizedText, contentWidth).map((line) =>
			truncateToWidth(this.prefix + line, width, ""),
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Affordance next to truncated Input/Output headers — click opens full preview. */
export const SHOW_MORE_LABEL = "[show more]";

export type ToolIoSection = "input" | "output";

/**
 * Expanded tool body with clear Input / Output sections (Grok Build–style).
 *
 * Visual frame:
 *   ┌ Input  [show more]
 *   │ path: src/a.ts
 *   │
 *   └ Output  [show more]
 *     result line…
 *
 * Reused across re-renders via context.lastComponent when possible.
 */
export class ExpandedToolIoView {
	private inputBody: string;
	private outputBody: string;
	private isError: boolean;
	private theme: any;
	private maxOutputLines: number;
	private maxInputLines: number;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	/** Which sections currently show the [show more] affordance (after last render). */
	private truncated: { input: boolean; output: boolean } = { input: false, output: false };

	constructor(
		theme: any,
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines = config.expandedPreviewMaxLines,
		maxInputLines = config.expandedPreviewMaxLines,
	) {
		this.theme = theme;
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = Math.max(1, maxOutputLines);
		this.maxInputLines = Math.max(1, maxInputLines);
	}

	setContent(
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines?: number,
		maxInputLines?: number,
	): void {
		const nextOut =
			maxOutputLines !== undefined ? Math.max(1, maxOutputLines) : this.maxOutputLines;
		const nextIn = maxInputLines !== undefined ? Math.max(1, maxInputLines) : this.maxInputLines;
		if (
			this.inputBody === inputBody &&
			this.outputBody === outputBody &&
			this.isError === isError &&
			this.maxOutputLines === nextOut &&
			this.maxInputLines === nextIn
		) {
			return;
		}
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = nextOut;
		this.maxInputLines = nextIn;
		this.invalidate();
	}

	getInputBody(): string {
		return this.inputBody;
	}

	getOutputBody(): string {
		return this.outputBody.trim() ? this.outputBody : "Done";
	}

	/** True when the plain header line is a truncated section with [show more]. */
	matchShowMoreLine(plainLine: string): ToolIoSection | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		if (!line.includes(SHOW_MORE_LABEL)) return null;
		if (/\bInput\b/.test(line) && this.truncated.input) return "input";
		if (/\bOutput\b/.test(line) && this.truncated.output) return "output";
		return null;
	}

	/** Column range (1-based, visible cells) of [show more] on a rendered header, if present. */
	showMoreHitbox(plainLine: string): { startCol: number; endCol: number } | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		const idx = line.indexOf(SHOW_MORE_LABEL);
		if (idx < 0) return null;
		const before = line.slice(0, idx);
		const startCol = visibleWidth(before) + 1;
		const endCol = startCol + visibleWidth(SHOW_MORE_LABEL) - 1;
		return { startCol, endCol };
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		const theme = this.theme;
		const safeWidth = Math.max(1, Math.floor(width));
		const rail = "  │ ";
		const railWidth = visibleWidth(rail);
		const contentWidth = Math.max(1, safeWidth - railWidth);
		const bodyColor = this.isError ? "error" : "toolOutput";
		const lines: string[] = [];
		this.truncated = { input: false, output: false };

		const pushHeader = (corner: "┌" | "└", label: string, showMore: boolean) => {
			const mark = theme.fg("dim", `  ${corner} `);
			const title = theme.fg(
				"accent",
				typeof theme.bold === "function" ? theme.bold(label) : label,
			);
			const more = showMore ? theme.fg("dim", ` ${SHOW_MORE_LABEL}`) : "";
			lines.push(truncateToWidth(mark + title + more, safeWidth, ""));
		};

		const pushRailLine = (styledContent: string) => {
			lines.push(truncateToWidth(theme.fg("dim", rail) + styledContent, safeWidth, ""));
		};

		const pushBlankRail = () => {
			lines.push(truncateToWidth(theme.fg("dim", "  │"), safeWidth, ""));
		};

		/** Style `key: value` input rows — dim keys, readable values. */
		const styleInputLine = (rawLine: string): string => {
			const match = rawLine.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
			if (!match) return theme.fg("muted", rawLine);
			const [, key, sep, rest] = match;
			return theme.fg("dim", key + sep) + theme.fg("text", rest ?? "");
		};

		const pushBody = (
			body: string,
			opts: { input?: boolean; limit: number },
		): boolean /* truncated */ => {
			const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
			if (!raw.trim()) {
				pushRailLine(theme.fg("dim", "(empty)"));
				return false;
			}
			const sourceLines = raw.split("\n");
			const wrapped: string[] = [];
			for (const source of sourceLines) {
				const styled = opts.input ? styleInputLine(source) : theme.fg(bodyColor, source);
				const parts = wrapTextWithAnsi(styled, contentWidth);
				if (parts.length === 0) wrapped.push(styled);
				else wrapped.push(...parts);
			}
			// Prefer source-line count so plain multi-line dumps always cap, even when
			// theme/wrap measurements disagree slightly.
			const truncated = wrapped.length > opts.limit || sourceLines.length > opts.limit;
			const visible = truncated ? wrapped.slice(0, Math.min(opts.limit, wrapped.length)) : wrapped;
			for (const line of visible) pushRailLine(line);
			if (truncated) {
				const hidden = Math.max(0, wrapped.length - visible.length);
				if (hidden > 0) {
					pushRailLine(theme.fg("dim", `… +${hidden} more lines`));
				}
			}
			return truncated;
		};

		const hasInput = this.inputBody.trim().length > 0;
		const outputText = this.getOutputBody();

		// Decide [show more] from the same truncation rules as pushBody.
		const inputWouldTruncate =
			hasInput &&
			bodyExceedsLineLimit(this.inputBody, this.maxInputLines, contentWidth, true, theme);
		const outputWouldTruncate = bodyExceedsLineLimit(
			outputText,
			this.maxOutputLines,
			contentWidth,
			false,
			theme,
			bodyColor,
		);

		if (hasInput) {
			this.truncated.input = inputWouldTruncate;
			pushHeader("┌", "Input", inputWouldTruncate);
			pushBody(this.inputBody, { input: true, limit: this.maxInputLines });
			pushBlankRail();
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output", outputWouldTruncate);
			pushBody(outputText, { limit: this.maxOutputLines });
		} else {
			this.truncated.output = outputWouldTruncate;
			pushHeader("┌", "Output", outputWouldTruncate);
			pushBody(outputText, { limit: this.maxOutputLines });
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** True when body needs truncation at the given line limit (source lines or wrapped rows). */
function bodyExceedsLineLimit(
	body: string,
	limit: number,
	contentWidth: number,
	asInput: boolean,
	theme: any,
	bodyColor = "toolOutput",
): boolean {
	const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
	if (!raw.trim()) return false;
	const sourceLines = raw.split("\n");
	if (sourceLines.length > limit) return true;
	let total = 0;
	for (const source of sourceLines) {
		let styled: string;
		if (asInput) {
			const match = source.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
			styled = match
				? theme.fg("dim", match[1] + match[2]) + theme.fg("text", match[3] ?? "")
				: theme.fg("muted", source);
		} else {
			styled = theme.fg(bodyColor, source);
		}
		const parts = wrapTextWithAnsi(styled, contentWidth);
		total += Math.max(1, parts.length);
		if (total > limit) return true;
	}
	return false;
}

export function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `  ↳ ${body}${collapsedHint}`;
}

/** Pretty-print tool call args for the expanded Input section. */
export function formatToolInputArgs(args: unknown, maxChars = 8_000): string {
	if (args === undefined || args === null) return "";
	if (typeof args !== "object") {
		const text = String(args);
		return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	}
	if (Array.isArray(args)) {
		try {
			const json = JSON.stringify(args, null, 2);
			return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
		} catch {
			return String(args);
		}
	}

	const entries = Object.entries(args as Record<string, unknown>).filter(
		([, value]) => value !== undefined,
	);
	if (entries.length === 0) return "";

	// Stable, human-first field order for common tools.
	const preferred = [
		"path",
		"file_path",
		"command",
		"query",
		"pattern",
		"url",
		"name",
		"message",
		"content",
		"old_string",
		"new_string",
	];
	entries.sort(([left], [right]) => {
		const li = preferred.indexOf(left);
		const ri = preferred.indexOf(right);
		if (li === -1 && ri === -1) return left.localeCompare(right);
		if (li === -1) return 1;
		if (ri === -1) return -1;
		return li - ri;
	});

	const lines: string[] = [];
	for (const [key, value] of entries) {
		if (typeof value === "string") {
			if (value.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of value.replace(/\t/g, "   ").split("\n")) {
					lines.push(`  ${line}`);
				}
			} else {
				lines.push(`${key}: ${value}`);
			}
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null) {
			lines.push(`${key}: ${String(value)}`);
			continue;
		}
		try {
			const json = JSON.stringify(value, null, 2);
			if (json.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of json.split("\n")) lines.push(`  ${line}`);
			} else {
				lines.push(`${key}: ${json}`);
			}
		} catch {
			lines.push(`${key}: [unserializable]`);
		}
	}
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function hasExpandableDetail(outputText: string, args: unknown): boolean {
	if (hasExpandableResult(outputText)) return true;
	return formatToolInputArgs(args).trim().length > 0;
}

function renderExpandedToolResult(
	body: string,
	theme: any,
	isError: boolean,
	lastComponent?: unknown,
	args?: unknown,
	context?: any,
): ExpandedToolIoView | ExpandedToolResultText | Text {
	const inputBody = formatToolInputArgs(args);
	const outputBody = body;
	const maxLines = config.expandedPreviewMaxLines;

	// Prefer structured Input/Output when we have args or non-empty output.
	if (inputBody.trim() || outputBody.trim()) {
		let view: ExpandedToolIoView;
		if (lastComponent instanceof ExpandedToolIoView) {
			lastComponent.setContent(inputBody, outputBody, isError, maxLines, maxLines);
			view = lastComponent;
		} else {
			view = new ExpandedToolIoView(theme, inputBody, outputBody, isError, maxLines, maxLines);
		}
		if (context) rememberIoView(context, view);
		return view;
	}

	if (context?.state) context.state.ccstyleIoView = undefined;
	const color = isError ? "error" : "muted";
	return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
}

function expandHint(theme: any): string {
	// Keep interaction guidance neutral; it should not inherit success/error
	// coloring from the tool result surrounding it.
	return `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "expand")}${theme.fg("muted", " / click)")}`;
}

type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

type ToolRenderHit = {
	component: any;
	start: number;
	end: number;
};

const TOOL_MOUSE_WIDGET_KEY = "ccstyle-tool-mouse";
const TOOL_MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const TOOL_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_SHORTCUT = "ctrl+end";
const ZENTUI_WHEEL_ROWS = 3;
const FIXED_EDITOR_WHEEL_ROWS = 5;
let toolMouseTui: any = null;
let toolMouseUi: any = null;
let toolMouseFixedFeaturesEnabled = false;
let wheelExtraRowRemainder = 0;
let lastWheelDirection: "up" | "down" | null = null;
let collapseCompensationRemainder = 0;
let toolMouseInputUnsubscribe: (() => void) | null = null;
let toolMouseInputPatchTui: any = null;
let toolMouseInputPatchOriginalHandle: ((...args: any[]) => any) | null = null;
let toolMouseInputPatchWrapper: ((...args: any[]) => any) | null = null;
let scrollButtonVisible = false;
let scrollButtonWidget: any = null;
let pendingScrollMessages = 0;
let assistantMessageActive = false;
let scrollButtonSyncScheduled = false;
let sessionRenderTimer: ReturnType<typeof setTimeout> | null = null;

function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = packet.code & ~(4 | 8 | 16 | 32);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

function stripTerminalSequences(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function isToolExecutionComponent(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof value.toolCallId === "string" &&
			typeof value.setExpanded === "function" &&
			typeof value.render === "function",
	);
}

function renderedLineCount(component: any, width: number, cache: WeakMap<object, number>): number {
	if (!component || typeof component !== "object") return 0;
	const cached = cache.get(component);
	if (cached !== undefined) return cached;

	let count = 0;
	try {
		const lines = component.render(width);
		count = Array.isArray(lines) ? lines.length : 0;
	} catch {
		count = 0;
	}
	cache.set(component, count);
	return count;
}

function collectToolRenderHits(
	component: any,
	start: number,
	width: number,
	hits: ToolRenderHit[],
	cache: WeakMap<object, number>,
	seen: Set<object>,
): number {
	if (!component || typeof component !== "object" || seen.has(component)) return start;
	seen.add(component);

	const count = renderedLineCount(component, width, cache);
	if (isToolExecutionComponent(component)) {
		if (count > 0) hits.push({ component, start, end: start + count });
		return start + count;
	}

	let childStart = start;
	if (Array.isArray(component.children)) {
		for (const child of component.children) {
			collectToolRenderHits(child, childStart, width, hits, cache, seen);
			childStart += renderedLineCount(child, width, cache);
		}
	}
	return start + count;
}

function collectToolComponents(component: any, tools: any[], seen = new Set<any>()): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (isToolExecutionComponent(component)) {
		tools.push(component);
		return;
	}
	if (!Array.isArray(component.children)) return;
	for (const child of component.children) collectToolComponents(child, tools, seen);
}

function fixedEditorLineMatch(rendered: string, visible: string): boolean {
	return (
		rendered === visible ||
		(visible.length >= 8 && (rendered.includes(visible) || visible.includes(rendered)))
	);
}

function fixedEditorContextScore(
	renderedLines: string[],
	renderedRow: number,
	visibleLines: string[],
	visibleRow: number,
): number {
	let score = renderedLines[renderedRow] === visibleLines[visibleRow] ? 100 : 50;
	for (const direction of [-1, 1]) {
		for (let distance = 1; distance <= 4; distance++) {
			const candidate = renderedLines[renderedRow + direction * distance];
			const visible = visibleLines[visibleRow + direction * distance];
			if (candidate === undefined || visible === undefined || candidate !== visible) break;
			score += 5 - distance;
		}
	}
	return score;
}

/** Collapsed tool rows expose "expand / click"; expanded body clicks do not. */
const COLLAPSED_TOOL_CLICK_HINT = /(?:expand|\/ click)/i;
/** fixedEditorContextScore max ≈ 100 + 2*(5+4+3+2); stop once we hit a near-perfect match. */
const TOOL_CLICK_EARLY_EXIT_SCORE = 120;

function findToolAtFixedEditorRow(
	tui: any,
	visibleRow: number,
	previousLines: string[],
	width: number,
): ToolRenderHit | null {
	if (visibleRow < 0 || visibleRow >= previousLines.length) return null;
	const visibleLines = previousLines.map((line) => stripTerminalSequences(String(line)));
	const clickedLine = visibleLines[visibleRow] ?? "";
	if (!clickedLine) return null;

	const tools: any[] = [];
	collectToolComponents(tui, tools);
	// Expand-hint → only collapsed tools; body click → only expanded (collapse-any-line).
	// Skips re-rendering the opposite half of the transcript tools.
	const wantExpanded = !COLLAPSED_TOOL_CLICK_HINT.test(clickedLine);
	let best: { hit: ToolRenderHit; score: number } | null = null;
	for (const component of tools) {
		if (Boolean(component.expanded) !== wantExpanded) continue;
		const renderedLines = renderComponentTree(component, width).map((line) =>
			stripTerminalSequences(String(line)),
		);
		for (let renderedRow = 0; renderedRow < renderedLines.length; renderedRow++) {
			if (!fixedEditorLineMatch(renderedLines[renderedRow] ?? "", clickedLine)) continue;
			const score = fixedEditorContextScore(renderedLines, renderedRow, visibleLines, visibleRow);
			if (!best || score > best.score) {
				best = {
					hit: { component, start: visibleRow, end: visibleRow + renderedLines.length },
					score,
				};
				if (score >= TOOL_CLICK_EARLY_EXIT_SCORE) return best.hit;
			}
		}
	}
	return best?.hit ?? null;
}

function findToolAtScreenRow(tui: any, screenRow: number): ToolRenderHit | null {
	const previousLines = Array.isArray(tui?.previousLines) ? tui.previousLines : [];
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	if (useFixedEditorFeatures(tui)) {
		// Zentui replaces Pi's root render with the already-sliced visible
		// transcript. previousViewportTop remains cursor bookkeeping and must not
		// be added to a physical mouse row here.
		return findToolAtFixedEditorRow(tui, screenRow - 1, previousLines, width);
	}
	const viewportTop = Number.isFinite(tui?.previousViewportTop) ? tui.previousViewportTop : 0;
	const bufferRow = viewportTop + screenRow - 1;
	if (bufferRow < 0 || bufferRow >= previousLines.length) return null;

	const hits: ToolRenderHit[] = [];
	const cache = new WeakMap<object, number>();
	collectToolRenderHits(tui, 0, width, hits, cache, new Set<object>());

	const clickedLine = stripTerminalSequences(String(previousLines[bufferRow] ?? ""));
	const wantExpanded = !COLLAPSED_TOOL_CLICK_HINT.test(clickedLine);
	for (const hit of hits) {
		if (bufferRow < hit.start || bufferRow >= hit.end) continue;
		// Same分流 as fixed-editor: hint clicks expand collapsed rows; body clicks
		// collapse expanded rows. Avoids accidental toggles on the wrong set.
		if (Boolean(hit.component.expanded) !== wantExpanded) continue;
		return hit;
	}
	return null;
}

function isFixedEditorTui(tui: any): boolean {
	const terminal = tui?.terminal;
	if (!terminal) return false;
	const ownRows = Object.getOwnPropertyDescriptor(terminal, "rows");
	const prototype = Object.getPrototypeOf(terminal);
	const inheritedRows = prototype ? Object.getOwnPropertyDescriptor(prototype, "rows") : undefined;
	return typeof ownRows?.get === "function" && ownRows.get !== inheritedRows?.get;
}

function useFixedEditorFeatures(tui: any): boolean {
	return toolMouseFixedFeaturesEnabled && isFixedEditorTui(tui);
}

function formatShortcut(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) =>
			part.length <= 1 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
		)
		.join("+");
}

function isScrollBottomInput(data: string): boolean {
	return matchesKey(data, SCROLL_BOTTOM_SHORTCUT);
}

function wheelDirection(data: string): "up" | "down" | null {
	const packets = parseSgrMousePackets(data);
	for (const packet of packets ?? []) {
		if (packet.final !== "M") continue;
		const baseButton = packet.code & ~(4 | 8 | 16 | 32);
		if (baseButton === 64) return "up";
		if (baseButton === 65) return "down";
	}
	return null;
}

/** Return how often Zentui's 3-row wheel handler should receive this event. */
export function fixedEditorWheelDispatchCount(direction: "up" | "down"): number {
	if (lastWheelDirection !== direction) {
		lastWheelDirection = direction;
		wheelExtraRowRemainder = 0;
	}
	wheelExtraRowRemainder += FIXED_EDITOR_WHEEL_ROWS - ZENTUI_WHEEL_ROWS;
	if (wheelExtraRowRemainder < ZENTUI_WHEEL_ROWS) return 1;
	wheelExtraRowRemainder -= ZENTUI_WHEEL_ROWS;
	return 2;
}

function isScrollNavigationInput(data: string): boolean {
	if (
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		ZENTUI_PAGE_UP_INPUT.test(data) ||
		ZENTUI_PAGE_DOWN_INPUT.test(data)
	) {
		return true;
	}
	const packets = parseSgrMousePackets(data);
	return Boolean(
		packets?.some((packet) => {
			const baseButton = packet.code & ~(4 | 8 | 16 | 32);
			return packet.final === "M" && (baseButton === 64 || baseButton === 65);
		}),
	);
}

function directRenderLines(component: any, width: number): string[] {
	try {
		const lines = component?.render?.(width);
		return Array.isArray(lines) ? lines : [];
	} catch {
		return [];
	}
}

/** Index just before the fixed editor cluster in the TUI child list. */
function fixedScrollableRootEnd(tui: any): number {
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const editorIndex = children.findIndex((child: any) =>
		containsEditorLike(child, tui.focusedComponent),
	);
	return editorIndex >= 2 ? editorIndex - 2 : children.length;
}

/**
 * Last N stripped lines of the scrollable root (after trimming trailing blanks).
 * Walks children backwards and stops once the tail is fully determined, so long
 * transcripts with many sibling nodes do not re-render the whole tree on scroll.
 */
function renderFixedScrollableRootTail(tui: any, width: number, matchLength: number): string[] {
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const end = fixedScrollableRootEnd(tui);
	const collected: string[] = [];
	for (let index = end - 1; index >= 0; index--) {
		const lines = directRenderLines(children[index], width).map((line) =>
			stripTerminalSequences(String(line)),
		);
		collected.unshift(...lines);
		let meaningful = collected.length;
		while (meaningful > 0 && collected[meaningful - 1] === "") meaningful--;
		if (meaningful >= matchLength) break;
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	if (collected.length === 0) return [];
	return collected.slice(-Math.min(matchLength, collected.length));
}

function isFixedEditorAtBottom(tui: any): boolean {
	if (!useFixedEditorFeatures(tui)) return true;
	const visibleLines = Array.isArray(tui?.previousLines) ? tui.previousLines : [];
	if (visibleLines.length === 0) return true;
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	const expected = renderFixedScrollableRootTail(tui, width, 3);
	if (expected.length === 0) return true;

	// previousLines contains both the scrollable root and Zentui's fixed cluster.
	// Locate the root tail within that full frame instead of requiring it to be
	// the frame suffix; otherwise status/editor/footer rows keep the button alive.
	const visible = visibleLines.map((line: unknown) => stripTerminalSequences(String(line)));
	const matchLength = expected.length;
	for (let end = matchLength; end <= visible.length; end++) {
		if (expected.every((line, index) => line === visible[end - matchLength + index])) return true;
	}
	return false;
}

function hideScrollButton(tui: any): void {
	const changed = scrollButtonVisible || pendingScrollMessages > 0;
	scrollButtonVisible = false;
	pendingScrollMessages = 0;
	if (changed) tui.requestRender?.();
}

function scheduleScrollButtonSync(tui: any, data: string): void {
	if (!useFixedEditorFeatures(tui) || !isScrollNavigationInput(data) || scrollButtonSyncScheduled)
		return;
	scrollButtonSyncScheduled = true;
	const previousLines = tui.previousLines;
	const check = (attempt: number) => {
		scrollButtonSyncScheduled = false;
		if (toolMouseTui !== tui) return;
		// Pi renders on its own frame timer. Inspect the resulting viewport before
		// showing the button so empty or non-scrollable transcripts never flash it.
		const rendered = tui.previousLines !== previousLines;
		if (!rendered && attempt < 4) {
			scrollButtonSyncScheduled = true;
			const timer = setTimeout(() => check(attempt + 1), 16);
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref: () => void }).unref();
			}
			return;
		}
		const nextVisible = !isFixedEditorAtBottom(tui);
		if (!nextVisible) pendingScrollMessages = 0;
		if (nextVisible !== scrollButtonVisible) {
			scrollButtonVisible = nextVisible;
			tui.requestRender?.();
		}
	};
	process.nextTick(() => check(0));
}

function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!useFixedEditorFeatures(tui)) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return") || isScrollBottomInput(data)) {
		hideScrollButton(tui);
	}
}

function renderComponentTree(component: any, width: number): string[] {
	if (!component || typeof component !== "object") return [];
	try {
		const lines = component.render?.(width);
		if (Array.isArray(lines) && lines.length > 0) return lines;
	} catch {
		// Fall through to children for hidden container renderers.
	}
	if (!Array.isArray(component.children)) return [];
	return component.children.flatMap((child: any) => renderComponentTree(child, width));
}

function renderTreeWithTarget(
	component: any,
	target: any,
	width: number,
	seen = new Set<any>(),
): { lines: string[]; targetStart: number | null } {
	if (!component || typeof component !== "object" || seen.has(component)) {
		return { lines: [], targetStart: null };
	}
	seen.add(component);
	if (component === target) {
		return { lines: renderComponentTree(component, width), targetStart: 0 };
	}

	if (Array.isArray(component.children)) {
		const lines: string[] = [];
		let targetStart: number | null = null;
		for (const child of component.children) {
			const result = renderTreeWithTarget(child, target, width, seen);
			if (result.targetStart !== null) targetStart = lines.length + result.targetStart;
			lines.push(...result.lines);
		}
		if (targetStart !== null) return { lines, targetStart };
	}

	return { lines: renderComponentTree(component, width), targetStart: null };
}

function normalizedClusterLines(component: any, width: number): string[] {
	if (!component) return [];
	const lines = renderComponentTree(component, width);
	let end = lines.length;
	while (end > 0 && visibleWidth(lines[end - 1] ?? "") === 0) end--;
	return lines.slice(0, Math.max(end, 1));
}

function rawTerminalRows(tui: any): number {
	const terminal = tui?.terminal;
	if (!terminal) return 0;
	const prototype = Object.getPrototypeOf(terminal);
	const rows = prototype ? Object.getOwnPropertyDescriptor(prototype, "rows") : undefined;
	if (typeof rows?.get === "function") {
		try {
			const value = rows.get.call(terminal);
			if (typeof value === "number" && Number.isFinite(value)) return value;
		} catch {
			// Fall through to the current terminal value.
		}
	}
	return typeof terminal.rows === "number" && Number.isFinite(terminal.rows) ? terminal.rows : 0;
}

function containsEditorLike(component: any, focused: any, seen = new Set<any>()): boolean {
	if (!component || typeof component !== "object" || seen.has(component)) return false;
	seen.add(component);
	if (component === focused) return true;
	if (
		typeof component.getText === "function" &&
		typeof component.setText === "function" &&
		typeof component.handleInput === "function"
	)
		return true;
	return (
		Array.isArray(component.children) &&
		component.children.some((child: any) => containsEditorLike(child, focused, seen))
	);
}

function scrollButtonScreenRow(tui: any, width: number): number | null {
	if (!scrollButtonVisible || !useFixedEditorFeatures(tui) || !scrollButtonWidget) return null;
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const editorIndex = children.findIndex((child: any) =>
		containsEditorLike(child, tui.focusedComponent),
	);
	if (editorIndex < 2 || editorIndex + 2 >= children.length) return null;

	const above = children[editorIndex - 1];
	const widthValue = Math.max(1, width || Number(tui?.terminal?.columns) || 80);
	const target = renderTreeWithTarget(above, scrollButtonWidget, widthValue);
	if (target.targetStart === null) return null;

	const rawRows = rawTerminalRows(tui);
	if (rawRows <= 0) return null;
	const maxRows = Math.max(1, rawRows - 1);
	const status = normalizedClusterLines(children[editorIndex - 2], widthValue);
	const editor = normalizedClusterLines(children[editorIndex], widthValue);
	const below = normalizedClusterLines(children[editorIndex + 1], widthValue);
	const footer = normalizedClusterLines(children[editorIndex + 2], widthValue);
	const aboveLines =
		target.lines.length > 0 ? target.lines : normalizedClusterLines(above, widthValue);

	const takeLast = (lines: string[], count: number): string[] =>
		count > 0 ? lines.slice(-count) : [];
	const editorVisible = takeLast(editor, Math.min(editor.length, maxRows));
	let remaining = Math.max(0, maxRows - editorVisible.length);
	const footerVisible = takeLast(footer, remaining);
	remaining -= footerVisible.length;
	const belowVisible = takeLast(below, remaining);
	remaining -= belowVisible.length;
	const aboveVisible = takeLast(aboveLines, remaining);
	const statusVisible = takeLast(status, Math.max(0, remaining - aboveVisible.length));
	const aboveStart = aboveLines.length - aboveVisible.length;
	const targetRow = target.targetStart - aboveStart;
	if (targetRow < 0 || targetRow >= aboveVisible.length) return null;

	const allLines = [
		...statusVisible,
		...aboveVisible,
		...editorVisible,
		...belowVisible,
		...footerVisible,
	];
	let leadingBlank = 0;
	while (leadingBlank < allLines.length - 1 && visibleWidth(allLines[leadingBlank] ?? "") === 0) {
		leadingBlank++;
	}
	const clusterRow = statusVisible.length + targetRow - leadingBlank;
	if (clusterRow < 0 || clusterRow >= allLines.length - leadingBlank) return null;
	return rawRows - allLines.length + clusterRow + 1;
}

function isScrollButtonAtScreenRow(tui: any, packet: SgrMousePacket): boolean {
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	if (scrollButtonScreenRow(tui, width) !== packet.row || !scrollButtonWidget) return false;
	const rendered = scrollButtonWidget.render?.(width)?.[0];
	if (typeof rendered !== "string") return false;
	const plain = rendered
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const leading = plain.length - plain.trimStart().length;
	const end = visibleWidth(plain.trimEnd());
	return packet.col >= leading + 1 && packet.col <= end;
}

function jumpToBottomWithoutSubmit(tui: any): boolean {
	const originalHandle = toolMouseInputPatchTui === tui ? toolMouseInputPatchOriginalHandle : null;
	if (!originalHandle) return false;

	// Route Enter through Pi's normal listener chain so pi-zentui can update its
	// private scroll offset, but suppress the focused editor for this synthetic
	// dispatch so clicking the button never submits the current input.
	const focused = tui.focusedComponent;
	try {
		tui.focusedComponent = null;
		Reflect.apply(originalHandle, tui, ["\r"]);
	} finally {
		tui.focusedComponent = focused;
	}
	hideScrollButton(tui);
	return true;
}

function handleScrollButtonClick(tui: any, packet: SgrMousePacket): boolean {
	if (!isScrollButtonAtScreenRow(tui, packet)) return false;
	return jumpToBottomWithoutSubmit(tui);
}

function scheduleCollapseViewportCompensation(
	tui: any,
	removedRows: number,
	packet: SgrMousePacket,
): void {
	if (removedRows <= 0 || !useFixedEditorFeatures(tui)) return;
	const originalHandle = toolMouseInputPatchTui === tui ? toolMouseInputPatchOriginalHandle : null;
	if (!originalHandle) return;

	process.nextTick(() => {
		if (toolMouseTui !== tui || toolMouseInputPatchOriginalHandle !== originalHandle) return;
		const targetRows = removedRows + collapseCompensationRemainder;
		const dispatches = Math.max(0, Math.round(targetRows / ZENTUI_WHEEL_ROWS));
		collapseCompensationRemainder = targetRows - dispatches * ZENTUI_WHEEL_ROWS;
		const wheelDown = `\x1b[<65;${packet.col};${packet.row}M`;
		for (let index = 0; index < dispatches; index++) {
			Reflect.apply(originalHandle, tui, [wheelDown]);
		}
	});
}

/** toolCallId → latest expanded IO view (survives context/state identity quirks). */
const ioViewsByToolCallId = new Map<string, ExpandedToolIoView>();

function rememberIoView(context: any, view: ExpandedToolIoView): void {
	if (!context || typeof context !== "object") return;
	if (!context.state || typeof context.state !== "object") context.state = {};
	const state = context.state as Record<string, unknown>;
	state.ccstyleIoView = view;
	const id =
		(typeof context?.toolCallId === "string" && context.toolCallId) ||
		(typeof context?.id === "string" && context.id) ||
		(typeof state?.toolCallId === "string" && state.toolCallId) ||
		undefined;
	if (id) {
		ioViewsByToolCallId.set(id, view);
		// Bound growth in long sessions.
		if (ioViewsByToolCallId.size > 200) {
			const oldest = ioViewsByToolCallId.keys().next().value;
			if (oldest !== undefined) ioViewsByToolCallId.delete(oldest);
		}
	}
}

function resolveIoViewFromTool(component: any): ExpandedToolIoView | null {
	const fromState = component?.state?.ccstyleIoView;
	if (fromState instanceof ExpandedToolIoView) return fromState;
	const id =
		(typeof component?.toolCallId === "string" && component.toolCallId) ||
		(typeof component?.state?.toolCallId === "string" && component.state.toolCallId) ||
		undefined;
	if (id) {
		const mapped = ioViewsByToolCallId.get(id);
		if (mapped) return mapped;
	}
	// Some hosts keep the last result component on the tool instance.
	const last = component?.lastComponent ?? component?.resultComponent ?? component?.content;
	if (last instanceof ExpandedToolIoView) return last;
	return null;
}

/**
 * If the click lands on a truncated section's [show more], open the /context-style
 * full-text preview instead of toggling expand/collapse.
 */
function tryOpenToolIoShowMore(tui: any, packet: SgrMousePacket, hit: ToolRenderHit): boolean {
	if (!Boolean(hit.component.expanded)) return false;
	const ioView = resolveIoViewFromTool(hit.component);
	if (!ioView) return false;

	const previousLines = Array.isArray(tui?.previousLines) ? tui.previousLines : [];
	const visibleRow = useFixedEditorFeatures(tui)
		? packet.row - 1
		: (Number.isFinite(tui?.previousViewportTop) ? tui.previousViewportTop : 0) + packet.row - 1;
	if (visibleRow < 0 || visibleRow >= previousLines.length) return false;

	const plain = stripTerminalSequences(String(previousLines[visibleRow] ?? ""));
	const section = ioView.matchShowMoreLine(plain);
	if (!section) return false;

	// Prefer the [show more] cells; allow a little slack so imprecise clicks still work.
	const box = ioView.showMoreHitbox(plain);
	if (box && packet.col > 0 && packet.col < box.startCol - 4) return false;

	const ui = toolMouseUi;
	if (!ui || typeof ui.custom !== "function") {
		ui?.notify?.("Full preview requires TUI custom UI", "warning");
		return true;
	}

	const title = section === "input" ? "Tool Input" : "Tool Output";
	const content = section === "input" ? ioView.getInputBody() : ioView.getOutputBody();
	// Fire-and-forget overlay; click is still consumed.
	void showTextPreview({ ui }, title, content || "(empty)");
	return true;
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const hit = findToolAtScreenRow(tui, packet.row);
	if (!hit) return false;

	if (tryOpenToolIoShowMore(tui, packet, hit)) return true;

	const wasExpanded = Boolean(hit.component.expanded);
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	const previousHeight = wasExpanded ? renderComponentTree(hit.component, width).length : 0;
	hit.component.setExpanded(!wasExpanded);
	hit.component.invalidate?.();
	const nextHeight = wasExpanded ? renderComponentTree(hit.component, width).length : 0;
	tui.requestRender?.();
	if (wasExpanded) {
		scheduleCollapseViewportCompensation(tui, previousHeight - nextHeight, packet);
	}
	return true;
}

function renderScrollButton(width: number, theme: any): string[] {
	if (!scrollButtonVisible || !useFixedEditorFeatures(toolMouseTui)) return [];
	const shortcut = formatShortcut(SCROLL_BOTTOM_SHORTCUT);
	const messageText =
		pendingScrollMessages > 0
			? `${pendingScrollMessages} new message${pendingScrollMessages === 1 ? "" : "s"}`
			: "Back to bottom";
	const label = theme.fg("accent", `[ ↓ ${messageText} · ${shortcut} ]`);
	const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
	return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
}

/**
 * pi-zentui consumes left-button presses for text selection. Intercept only a
 * tool-row click at the TUI input boundary, before extension listeners run.
 * Keyboard, wheel, drag, release, and non-tool clicks continue through Pi's
 * original dispatcher, preserving pi-zentui's scroll-to-bottom behavior.
 */
function patchToolMouseInputCapture(tui: any): void {
	if (toolMouseInputPatchTui === tui) return;

	restoreToolMouseInputCapture();
	const originalHandle = tui?.handleInput;
	if (typeof originalHandle !== "function") return;

	const wrapper = function (this: any, ...args: any[]): any {
		const data = args[0];
		if (typeof data === "string") {
			updateScrollButtonFromInput(this, data);
			// Capture the current viewport before Pi/Zentui applies the scroll input.
			scheduleScrollButtonSync(this, data);
			if (
				useFixedEditorFeatures(this) &&
				isScrollBottomInput(data) &&
				jumpToBottomWithoutSubmit(this)
			)
				return;
			const packets = parseSgrMousePackets(data);
			if (packets) {
				for (const packet of packets) {
					if (!isSgrLeftPress(packet)) continue;
					if (handleScrollButtonClick(this, packet) || toggleToolAtMouseClick(this, packet)) return;
				}
			}
		}
		const direction =
			typeof data === "string" && useFixedEditorFeatures(this) ? wheelDirection(data) : null;
		const dispatchCount = direction ? fixedEditorWheelDispatchCount(direction) : 1;
		let result = Reflect.apply(originalHandle, this, args);
		for (let index = 1; index < dispatchCount; index++) {
			result = Reflect.apply(originalHandle, this, args);
		}
		if (typeof data === "string") scheduleScrollButtonSync(this, data);
		return result;
	};

	try {
		tui.handleInput = wrapper;
	} catch {
		return;
	}
	toolMouseInputPatchTui = tui;
	toolMouseInputPatchOriginalHandle = originalHandle;
	toolMouseInputPatchWrapper = wrapper;
}

function restoreToolMouseInputCapture(): void {
	if (
		toolMouseInputPatchTui &&
		toolMouseInputPatchOriginalHandle &&
		toolMouseInputPatchTui.handleInput === toolMouseInputPatchWrapper
	) {
		toolMouseInputPatchTui.handleInput = toolMouseInputPatchOriginalHandle;
	}
	toolMouseInputPatchTui = null;
	toolMouseInputPatchOriginalHandle = null;
	toolMouseInputPatchWrapper = null;
}

function handleToolMouseInput(data: string): { consume: true } | undefined {
	if (!toolMouseTui) return undefined;
	updateScrollButtonFromInput(toolMouseTui, data);
	if (isScrollBottomInput(data)) {
		if (useFixedEditorFeatures(toolMouseTui) && jumpToBottomWithoutSubmit(toolMouseTui)) {
			return { consume: true };
		}
		if (!toolMouseFixedFeaturesEnabled) {
			// Native Pi scrolls through terminal history rather than an internal
			// viewport. A harmless terminal write makes Ctrl+End snap that history
			// to the active cursor without enabling mouse reporting.
			toolMouseTui.terminal?.write?.("\x1b[0m");
			toolMouseTui.requestRender?.();
			return { consume: true };
		}
	}
	const packets = parseSgrMousePackets(data);
	if (!packets) {
		scheduleScrollButtonSync(toolMouseTui, data);
		return undefined;
	}

	let consumed = false;
	for (const packet of packets) {
		if (!isSgrLeftPress(packet)) continue;
		if (
			handleScrollButtonClick(toolMouseTui, packet) ||
			toggleToolAtMouseClick(toolMouseTui, packet)
		) {
			consumed = true;
		}
	}

	// Let scrolling, motion, release, and clicks outside tool results reach the
	// normal TUI input chain (including other extensions such as pi-zentui).
	scheduleScrollButtonSync(toolMouseTui, data);
	return consumed ? { consume: true } : undefined;
}

function teardownToolMouseInteraction(): void {
	if (sessionRenderTimer) {
		clearTimeout(sessionRenderTimer);
		sessionRenderTimer = null;
	}
	toolMouseInputUnsubscribe?.();
	toolMouseInputUnsubscribe = null;
	try {
		toolMouseTui?.terminal?.write?.(TOOL_MOUSE_DISABLE);
	} catch {
		// The terminal may already be closed during shutdown.
	}
	try {
		toolMouseUi?.setWidget?.(TOOL_MOUSE_WIDGET_KEY, undefined);
	} catch {
		// The UI context may already have been reset during /reload.
	}
	restoreToolMouseInputCapture();
	scrollButtonVisible = false;
	scrollButtonWidget = null;
	pendingScrollMessages = 0;
	assistantMessageActive = false;
	scrollButtonSyncScheduled = false;
	toolMouseTui = null;
	toolMouseUi = null;
	toolMouseFixedFeaturesEnabled = false;
	wheelExtraRowRemainder = 0;
	lastWheelDirection = null;
	collapseCompensationRemainder = 0;
}

export function installToolMouseInteraction(
	ctx: any,
	fixedEditorFeatures = config.fixedEditorFeatures,
): void {
	teardownToolMouseInteraction();
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.onTerminalInput !== "function" || typeof ctx.ui?.setWidget !== "function")
		return;

	toolMouseUi = ctx.ui;
	toolMouseFixedFeaturesEnabled = fixedEditorFeatures;
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		toolMouseTui = tui;
		if (fixedEditorFeatures) {
			patchToolMouseInputCapture(tui);
			tui?.terminal?.write?.(TOOL_MOUSE_ENABLE);
		}
		const widget = {
			render: (width: number) => renderScrollButton(width, theme),
			invalidate() {},
		};
		scrollButtonWidget = widget;
		return widget;
	});
	toolMouseInputUnsubscribe = ctx.ui.onTerminalInput(handleToolMouseInput);
}

function scheduleSessionRender(refresh?: () => void): void {
	const tui = toolMouseTui;
	if (!tui || typeof tui.requestRender !== "function") return;
	if (sessionRenderTimer) clearTimeout(sessionRenderTimer);
	// Restored transcripts are populated at different points for startup, reload,
	// and session replacement. Repaint after session_start and the surrounding UI
	// rebuild finish so messages are not left hidden until the next terminal input.
	sessionRenderTimer = setTimeout(() => {
		sessionRenderTimer = null;
		if (toolMouseTui !== tui) return;
		refresh?.();
		tui.requestRender(true);
	}, 0);
}

// Bright green for success icon (truecolor ANSI escape)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_RESET = "\x1b[0m";

function refreshCurrentTranscript(compactStyle: CompactStyleHooks, ctx?: any): void {
	compactStyle.refresh();
	toolMouseTui?.requestRender?.(true);
	ctx?.ui?.requestRender?.(true);
}

function applyStyleMode(mode: CompactStyleMode, ctx: any, compactStyle: CompactStyleHooks): void {
	config.mode = mode;
	saveConfig();
	refreshCurrentTranscript(compactStyle, ctx);
	ctx.ui.notify(`Claude Code style: ${mode}`, "info");
}

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "compact") {
		return "Compact transcript summaries. Fixed editor and diff options below still apply independently.";
	}
	if (mode === "off") {
		return "Pi native tool rendering. Fixed editor and diff options below still apply independently.";
	}
	return "Claude Code style with rich edit/write diffs. Tune fixed editor and diff options below.";
}

function fixedEditorSettingDescription(enabled: boolean): string {
	return enabled
		? "Mouse capture, 5-row wheel, tool click expand/collapse, viewport mapping, back-to-bottom button, message count, Ctrl+End."
		: "Terminal-native wheel; mouse capture, tool clicks, viewport mapping, and button off. Ctrl+End remains enabled.";
}

function excludeRenderersDescription(names: readonly string[]): string {
	return names.length === 0
		? "No tools excluded. Agent always keeps its dedicated renderer. Enter to toggle common tools."
		: `Native renderer for: ${names.join(", ")}. Agent is always native. Enter to toggle.`;
}

function diffViewModeDescription(mode: DiffViewMode): string {
	if (mode === "split") return "Force side-by-side diff when width allows; otherwise unified.";
	if (mode === "unified") return "Always render a single unified diff column.";
	return "Auto: split when terminal is wide enough, otherwise unified.";
}

function diffIndicatorDescription(mode: DiffIndicatorMode): string {
	if (mode === "classic") return "Classic +/- gutters on changed lines.";
	if (mode === "none") return "No change indicators; rely on color alone.";
	return "Vertical bar indicators on changed lines (default).";
}

function buildExcludeRenderersSubmenu(
	onClose: () => void,
	onLiveChange: () => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const candidates = [
		...new Set([...EXCLUDE_RENDERER_CANDIDATES, ...config.excludeRenderers]),
	].sort((a, b) => a.localeCompare(b));
	const items = candidates.map((name) => ({
		id: name,
		label: name,
		description:
			name === "Agent"
				? "Agent always uses its dedicated renderer and cannot be forced through ccstyle."
				: `Use Pi native renderer for ${name} instead of Claude Code / compact styling.`,
		currentValue: config.excludeRenderers.includes(name) ? "exclude" : "style",
		values: ["style", "exclude"],
	}));
	const list = new SettingsList(
		items,
		Math.min(8, Math.max(4, items.length)),
		getSettingsListTheme(),
		(id: string, value: string) => {
			const excluded = new Set(config.excludeRenderers);
			if (value === "exclude") excluded.add(id);
			else excluded.delete(id);
			config.excludeRenderers = [...excluded].sort((a, b) => a.localeCompare(b));
			saveConfig();
			onLiveChange();
		},
		() => onClose(),
		{ enableSearch: candidates.length > 8 },
	);
	return {
		render: (width: number) => [
			...list.render(width),
			"",
			// Extra hint: Esc returns to the Style section list.
			truncateToWidth("  Esc back to Style settings", width),
		],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

/** Section tabs for /ccstyle — matches Zentui-style "A / B / C" headers. */
type CcstyleSection = {
	id: "style" | "editor" | "diff";
	label: string;
	items: any[];
};

function isForwardTabKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isBackTabKey(data: string): boolean {
	// CSI Z is the common terminal encoding for Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

function renderPanelRule(theme: any, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderSectionTabBar(
	theme: any,
	sections: readonly { label: string }[],
	activeIndex: number,
	width: number,
): string {
	const pieces: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) pieces.push(theme.fg("dim", " / "));
		const label = sections[i]?.label ?? "";
		pieces.push(
			i === activeIndex
				? theme.fg("text", typeof theme.bold === "function" ? theme.bold(label) : label)
				: theme.fg("dim", label),
		);
	}
	return truncateToWidth(pieces.join(""), Math.max(0, width));
}

async function showCcstylePanel(ctx: any, compactStyle: CompactStyleHooks): Promise<void> {
	if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		const modeSetting = {
			id: "mode",
			label: "Mode",
			description: modeSettingDescription(config.mode),
			currentValue: config.mode,
			values: ["on", "off", "compact"],
		};
		const fixedEditorSetting = {
			id: "fixedEditorFeatures",
			label: "Fixed editor",
			description: fixedEditorSettingDescription(config.fixedEditorFeatures),
			currentValue: config.fixedEditorFeatures ? "on" : "off",
			values: ["on", "off"],
		};
		// Tracks whether the Exclude-tools submenu is open so Tab switches sections
		// only at the top level (mirrors Zentui settings: Tab = switch sections).
		let excludeSubmenuOpen = false;
		const excludeSetting = {
			id: "excludeRenderers",
			label: "Exclude tools",
			description: excludeRenderersDescription(config.excludeRenderers),
			currentValue: formatExcludeRenderers(config.excludeRenderers),
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) => {
				excludeSubmenuOpen = true;
				return buildExcludeRenderersSubmenu(
					() => {
						excludeSubmenuOpen = false;
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						closeSubmenu();
					},
					() => {
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
						refreshCurrentTranscript(compactStyle, ctx);
					},
				);
			},
		};
		const diffViewSetting = {
			id: "diffViewMode",
			label: "Diff layout",
			description: diffViewModeDescription(config.diffViewMode),
			currentValue: config.diffViewMode,
			values: [...DIFF_VIEW_MODES],
		};
		const diffIndicatorSetting = {
			id: "diffIndicatorMode",
			label: "Diff indicator",
			description: diffIndicatorDescription(config.diffIndicatorMode),
			currentValue: config.diffIndicatorMode,
			values: [...DIFF_INDICATOR_MODES],
		};
		const diffSplitSetting = {
			id: "diffSplitMinWidth",
			label: "Split min width",
			description: "Minimum terminal width before auto/split layout uses side-by-side columns.",
			currentValue: nearestPreset(config.diffSplitMinWidth, DIFF_SPLIT_MIN_WIDTH_VALUES),
			values: [...DIFF_SPLIT_MIN_WIDTH_VALUES],
		};
		const diffCollapsedSetting = {
			id: "diffCollapsedLines",
			label: "Collapsed lines",
			description: "How many diff body lines to show before the expand hint (Ctrl+O / click).",
			currentValue: nearestPreset(config.diffCollapsedLines, DIFF_COLLAPSED_LINES_VALUES),
			values: [...DIFF_COLLAPSED_LINES_VALUES],
		};
		const diffWordWrapSetting = {
			id: "diffWordWrap",
			label: "Diff word wrap",
			description: config.diffWordWrap
				? "Long diff lines wrap within the panel width."
				: "Long diff lines are truncated to the panel width.",
			currentValue: config.diffWordWrap ? "on" : "off",
			values: ["on", "off"],
		};
		const expandedMaxSetting = {
			id: "expandedPreviewMaxLines",
			label: "Expanded max lines",
			description:
				"Max Output/diff body lines when expanded. Default 40 keeps the TUI compact; raise for large dumps.",
			currentValue: nearestPreset(
				config.expandedPreviewMaxLines,
				EXPANDED_PREVIEW_MAX_LINES_VALUES,
			),
			values: [...EXPANDED_PREVIEW_MAX_LINES_VALUES],
		};

		const onSettingChange = (id: string, value: string) => {
			switch (id) {
				case "mode":
					modeSetting.description = modeSettingDescription(value as CompactStyleMode);
					applyStyleMode(value as CompactStyleMode, ctx, compactStyle);
					return;
				case "fixedEditorFeatures":
					config.fixedEditorFeatures = value === "on";
					fixedEditorSetting.description = fixedEditorSettingDescription(
						config.fixedEditorFeatures,
					);
					saveConfig();
					installToolMouseInteraction(ctx);
					refreshCurrentTranscript(compactStyle, ctx);
					ctx.ui.notify(`Fixed editor: ${value}`, "info");
					return;
				case "excludeRenderers":
					excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
					excludeSetting.description = excludeRenderersDescription(config.excludeRenderers);
					return;
				case "diffViewMode":
					config.diffViewMode = value as DiffViewMode;
					diffViewSetting.description = diffViewModeDescription(config.diffViewMode);
					break;
				case "diffIndicatorMode":
					config.diffIndicatorMode = value as DiffIndicatorMode;
					diffIndicatorSetting.description = diffIndicatorDescription(config.diffIndicatorMode);
					break;
				case "diffSplitMinWidth":
					config.diffSplitMinWidth = pickPositiveInt(
						value,
						DEFAULT_CONFIG.diffSplitMinWidth,
						40,
						300,
					);
					break;
				case "diffCollapsedLines":
					config.diffCollapsedLines = pickPositiveInt(
						value,
						DEFAULT_CONFIG.diffCollapsedLines,
						1,
						500,
					);
					break;
				case "diffWordWrap":
					config.diffWordWrap = value === "on";
					diffWordWrapSetting.description = config.diffWordWrap
						? "Long diff lines wrap within the panel width."
						: "Long diff lines are truncated to the panel width.";
					break;
				case "expandedPreviewMaxLines":
					config.expandedPreviewMaxLines = pickPositiveInt(
						value,
						DEFAULT_CONFIG.expandedPreviewMaxLines,
						10,
						50_000,
					);
					break;
				default:
					return;
			}
			saveConfig();
			refreshCurrentTranscript(compactStyle, ctx);
			ctx.ui.notify(`Updated ${id}: ${value}`, "info");
		};

		const sections: CcstyleSection[] = [
			{
				id: "style",
				label: "Style",
				items: [modeSetting, excludeSetting],
			},
			{
				id: "editor",
				label: "Editor",
				items: [fixedEditorSetting],
			},
			{
				id: "diff",
				label: "Diff",
				items: [
					diffViewSetting,
					diffIndicatorSetting,
					diffSplitSetting,
					diffCollapsedSetting,
					diffWordWrapSetting,
					expandedMaxSetting,
				],
			},
		];

		let activeSection = 0;
		const settingsTheme = getSettingsListTheme();
		const lists = sections.map(
			(section) =>
				new SettingsList(
					section.items,
					Math.min(8, Math.max(section.items.length, 1)),
					settingsTheme,
					onSettingChange,
					() => done(),
					{ enableSearch: false },
				),
		);

		const activeList = () => lists[activeSection]!;

		const switchSection = (delta: number) => {
			if (excludeSubmenuOpen) return;
			activeSection = (activeSection + delta + sections.length) % sections.length;
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(0, Math.floor(width));
				const rule = renderPanelRule(theme, safeWidth);
				const body = activeList().render(safeWidth);
				// Drop SettingsList's built-in hint — the panel footer below is the single source.
				while (body.length > 0 && body[body.length - 1] === "") body.pop();
				const listHintIndex = body.findIndex(
					(line) =>
						typeof line === "string" &&
						(line.includes("Enter/Space to change") || line.includes("Esc to cancel")),
				);
				const listBody = listHintIndex >= 0 ? body.slice(0, listHintIndex) : body;
				while (listBody.length > 0 && listBody[listBody.length - 1] === "") listBody.pop();

				// Frame: top rule · tabs · mid rule · settings · mid rule · footer · bottom rule
				return [
					rule,
					renderSectionTabBar(theme, sections, activeSection, safeWidth),
					rule,
					...listBody,
					rule,
					truncateToWidth(
						theme.fg(
							"dim",
							"  Enter/Space to change · Tab/Shift+Tab to switch sections · Esc to close",
						),
						safeWidth,
					),
					rule,
				];
			},
			invalidate() {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string) {
				if (!excludeSubmenuOpen && isForwardTabKey(data)) {
					switchSection(1);
					tui.requestRender();
					return;
				}
				if (!excludeSubmenuOpen && isBackTabKey(data)) {
					switchSection(-1);
					tui.requestRender();
					return;
				}
				activeList().handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

/**
 * Generate a descriptive label for an unknown tool from its args.
 * Uses the tool label + first stringable arg value.
 */
function toolCallLabel(toolName: string, toolLabel: string, args: any): string {
	if (!args) return toolLabel;
	const keys = Object.keys(args);
	if (keys.length === 0) return toolLabel;
	// Prefer "query" or "question" args, then fall back to the first stringable value
	const preferred = ["query", "question", "command", "pattern", "name", "path", "url", "message"];
	for (const key of preferred) {
		const val = args[key];
		if (val !== undefined && val !== null && typeof val !== "object") {
			return `${toolLabel}(${oneLine(val, 60)})`;
		}
	}
	const firstKey = keys[0];
	const firstVal = args[firstKey];
	if (firstVal !== undefined && firstVal !== null && typeof firstVal !== "object") {
		return `${toolLabel}(${oneLine(firstVal, 60)})`;
	}
	return toolLabel;
}

export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

/** Wrap an arbitrary tool definition with ccstyle call/result rendering. */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? toolName
		: originalTool.label || toolName;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState && (context?.isPartial || context?.executionStarted));
			if (isPending) scheduleAnimation(context);
			const rawIcon = isPending ? pendingIcon(toolName) : settledIcon(toolName, visualState);
			const icon =
				visualState === "success"
					? `${BRIGHT_GREEN}${rawIcon}${ANSI_RESET}`
					: theme.fg(toolIconColor(context), rawIcon);

			const title = `${icon} ${theme.fg("toolTitle", toolCallLabel(toolName, label, args))}`;
			return new Text(title, 0, 0);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			if (options?.isPartial) {
				return new Text(theme.fg("muted", "  ⎿ Pending…"), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const expanded = isToolExpanded(options, context);
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				const richResult = renderRichToolResult(
					toolName,
					result,
					{ ...options, expanded },
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig(),
				);
				if (richResult) return richResult;
			}

			const text = textFromResult(result);
			const args = context?.args;
			const rendered = !expanded ? (text ? oneLine(text, 96) : "Done") : text;

			const hint = !expanded && hasExpandableDetail(text, args) ? expandHint(theme) : "";
			if (expanded) {
				return renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
				);
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			return new Text(
				theme.fg(isError ? "error" : "muted", renderCollapsedToolResult(rendered, hint)),
				0,
				0,
			);
		},
	};
}

/**
 * Apart from the write override used to capture pre-write content, renderers are
 * applied through ToolExecutionComponent. Patch its lookup once so tools use the
 * same compact fallback shell by default. Tools named in excludeRenderers keep
 * their original renderer; subagent rendering remains protected.
 */
const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
const COMPONENT_TOOL_SELF_SHELL_MODE = Symbol.for("pi.ccstyle.component-tool-self-shell-mode");
const SUBAGENT_TOOL_NAMES = new Set(["Agent"]);

type ToolRenderMethods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	owner: object;
	active: boolean;
	enabled: () => boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	// Keep the legacy aliases so an older extension build can read this Symbol.
	originalHasRendererDefinition: ToolRenderMethods["hasRendererDefinition"];
	originalGetRenderShell: ToolRenderMethods["getRenderShell"];
	originalGetCallRenderer: ToolRenderMethods["getCallRenderer"];
	originalGetResultRenderer: ToolRenderMethods["getResultRenderer"];
};

function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label : "";
	return toolName === "mcp" || label === "MCP" || label.startsWith("MCP: ");
}

/** Return true when this tool must keep its original renderer. */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (SUBAGENT_TOOL_NAMES.has(toolName)) return true;
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some(
		(definition) =>
			definition?.renderShell === "self" ||
			typeof definition?.renderCall === "function" ||
			typeof definition?.renderResult === "function",
	);
}

function syncToolShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(
		[component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean),
	);
	const indexes = component.children
		.map((child: any, index: number) => (candidates.has(child) ? index : -1))
		.filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// During construction getRenderShell() runs immediately before Pi mounts the
	// selected shell. Do not mount it here or the constructor will add it twice.
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.mode() === "on" &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function shouldUseSelfShell(component: any, patch: GlobalToolRenderPatch): boolean {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useSelfShell =
		patch.enabled() &&
		SUBAGENT_TOOL_NAMES.has(toolName) &&
		definition != null &&
		definition.renderShell === undefined;
	component[COMPONENT_TOOL_SELF_SHELL_MODE] = useSelfShell;
	return useSelfShell;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function prototypeToolRenderMethods(prototype: any): ToolRenderMethods {
	return {
		hasRendererDefinition: prototype.hasRendererDefinition,
		getRenderShell: prototype.getRenderShell,
		getCallRenderer: prototype.getCallRenderer,
		getResultRenderer: prototype.getResultRenderer,
	};
}

function isOwnershipAwarePatch(value: any): value is GlobalToolRenderPatch {
	if (!value || value.version !== 2 || !value.installed || !value.downstream) return false;
	return ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"].every(
		(name) =>
			typeof value.installed[name] === "function" && typeof value.downstream[name] === "function",
	);
}

function isLegacyInstalledWrapper(method: unknown, downstreamField: string): boolean {
	if (typeof method !== "function") return false;
	try {
		const source = Function.prototype.toString.call(method);
		return (
			source.includes(downstreamField) &&
			(source.includes("shouldGloballyStyleTool") ||
				source.includes("shouldUseSelfShell") ||
				source.includes("getGloballyStyledTool"))
		);
	} catch {
		return false;
	}
}

function downstreamForGlobalToolInstall(prototype: any, previous: any): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype) return current;
	if (isOwnershipAwarePatch(previous)) {
		return {
			hasRendererDefinition:
				current.hasRendererDefinition === previous.installed.hasRendererDefinition
					? previous.downstream.hasRendererDefinition
					: current.hasRendererDefinition,
			getRenderShell:
				current.getRenderShell === previous.installed.getRenderShell
					? previous.downstream.getRenderShell
					: current.getRenderShell,
			getCallRenderer:
				current.getCallRenderer === previous.installed.getCallRenderer
					? previous.downstream.getCallRenderer
					: current.getCallRenderer,
			getResultRenderer:
				current.getResultRenderer === previous.installed.getResultRenderer
					? previous.downstream.getResultRenderer
					: current.getResultRenderer,
		};
	}

	// Pre-v2 Symbol state did not retain wrapper references. Recognize its known
	// wrappers when possible; otherwise preserve the current method as external.
	const legacyDownstream = (method: Function, field: string): Function => {
		const saved = previous[field];
		return typeof saved === "function" && isLegacyInstalledWrapper(method, field) ? saved : method;
	};
	return {
		hasRendererDefinition: legacyDownstream(
			current.hasRendererDefinition,
			"originalHasRendererDefinition",
		) as ToolRenderMethods["hasRendererDefinition"],
		getRenderShell: legacyDownstream(
			current.getRenderShell,
			"originalGetRenderShell",
		) as ToolRenderMethods["getRenderShell"],
		getCallRenderer: legacyDownstream(
			current.getCallRenderer,
			"originalGetCallRenderer",
		) as ToolRenderMethods["getCallRenderer"],
		getResultRenderer: legacyDownstream(
			current.getResultRenderer,
			"originalGetResultRenderer",
		) as ToolRenderMethods["getResultRenderer"],
	};
}

function disconnectGlobalToolRenderPatch(patch: any): void {
	if (!patch || typeof patch !== "object") return;
	patch.active = false;
	patch.enabled = () => false;
	patch.mode = () => "off";
	patch.wrap = (tool: any) => tool;
	patch.byDefinition = new WeakMap();
	if (patch.byName && typeof patch.byName.clear === "function") patch.byName.clear();
	else patch.byName = new Map();
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const host = globalThis as any;
	const previous = host[GLOBAL_TOOL_RENDER_PATCH];
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	// Any wrapper retained by an external owner must become a callback-free
	// pass-through before the new installation is linked above it.
	disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		owner: {},
		active: true,
		enabled: () => config.mode === "on",
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalHasRendererDefinition: downstream.hasRendererDefinition,
		originalGetRenderShell: downstream.getRenderShell,
		originalGetCallRenderer: downstream.getCallRenderer,
		originalGetResultRenderer: downstream.getResultRenderer,
	};

	patch.installed = {
		hasRendererDefinition: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) return true;
			return patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell: function (this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const shell =
				shouldUseSelfShell(this, patch) || shouldGloballyStyleTool(this, patch)
					? "self"
					: patch.downstream.getRenderShell.apply(this, args);
			syncToolShell(this, shell);
			return shell;
		},
		getCallRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderCall;
			}
			return patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderResult;
			}
			return patch.downstream.getResultRenderer.apply(this, args);
		},
	};

	prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	host[GLOBAL_TOOL_RENDER_PATCH] = patch;
	return patch;
}

function deactivateGlobalToolRendering(patch: GlobalToolRenderPatch): void {
	if (!patch.active) return;
	disconnectGlobalToolRenderPatch(patch);
	const prototype = patch.prototype;
	if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
		prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
	}
	if (prototype.getRenderShell === patch.installed.getRenderShell) {
		prototype.getRenderShell = patch.downstream.getRenderShell;
	}
	if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
		prototype.getCallRenderer = patch.downstream.getCallRenderer;
	}
	if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
		prototype.getResultRenderer = patch.downstream.getResultRenderer;
	}
}

const GLOBAL_COMPACTION_RENDER_PATCH = Symbol.for("pi.ccstyle.compaction-render-patch");

type LegacyCompactionRenderPatch = {
	enabled?: () => boolean;
};

/** Disable the pre-native compaction monkey patch left alive by /reload. */
function deactivateLegacyCompactionRendering() {
	const patch = (globalThis as any)[GLOBAL_COMPACTION_RENDER_PATCH] as
		| LegacyCompactionRenderPatch
		| undefined;
	if (patch) patch.enabled = () => false;
}

function notePendingScrollMessage(role: unknown): void {
	if (!toolMouseTui || !useFixedEditorFeatures(toolMouseTui) || !scrollButtonVisible) return;
	if (role === "assistant") {
		if (assistantMessageActive) return;
		assistantMessageActive = true;
	} else if (role !== "toolResult") {
		return;
	}
	pendingScrollMessages += 1;
	toolMouseTui.requestRender?.();
}

export default function (pi: ExtensionAPI, configOverride?: Partial<Config>) {
	// The optional override keeps integration tests independent from the user's global config.
	if (configOverride) config = normalizeConfig({ ...config, ...configOverride });
	const writeExecutionMetadata = installWriteOverride(pi, new WriteExecutionMetadataStore());
	const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
	deactivateLegacyCompactionRendering();
	const compactStyle: CompactStyleHooks = installCompactStyle(pi, {
		getMode: () => config.mode,
		getExcludeRenderers: () => config.excludeRenderers,
	});

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style, fixed editor, and rich diff options",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{ value: "off", label: "off", description: "Use Pi's native renderer" },
				{ value: "compact", label: "compact", description: "Use compact transcript rendering" },
				{ value: "status", label: "status", description: "Show full configuration" },
				{ value: "panel", label: "panel", description: "Open interactive settings panel" },
			];
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "panel") {
				await showCcstylePanel(ctx, compactStyle);
				return;
			}
			if (arg === "on" || arg === "off" || arg === "compact") {
				applyStyleMode(arg, ctx, compactStyle);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Claude Code style: ${formatConfigStatus(config)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|off|compact|status|panel]", "warning");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		compactStyle?.onSessionStart(event, ctx);
		pendingScrollMessages = 0;
		assistantMessageActive = false;
		ctx.ui.setStatus("ccstyle", undefined);
		installToolMouseInteraction(ctx);
		scheduleSessionRender(compactStyle.refresh);
	});

	pi.on("session_compact", async (event, ctx) => {
		compactStyle?.onSessionCompact(event, ctx);
		// Compaction rebuilds the transcript without session_start. Rebind after
		// other TUI extensions may have replaced the root input dispatcher.
		installToolMouseInteraction(ctx);
		scheduleSessionRender(compactStyle.refresh);
	});

	pi.on("message_start", async (event) => {
		notePendingScrollMessage(event?.message?.role);
	});

	pi.on("message_update", async (event, ctx) => {
		compactStyle?.onMessageUpdate(event, ctx);
		if (event?.message?.role === "assistant") notePendingScrollMessage("assistant");
	});

	pi.on("message_end", async (event) => {
		if (event?.message?.role === "assistant") assistantMessageActive = false;
	});

	pi.on("agent_start", async (event, ctx) => {
		compactStyle?.onAgentStart(event, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		compactStyle?.onAgentEnd(event, ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		compactStyle?.onTurnStart(event, ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		compactStyle?.onToolExecutionStart(event, ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		compactStyle?.onToolExecutionUpdate(event, ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		compactStyle?.onToolExecutionEnd(event, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		compactStyle?.onSessionShutdown(event, ctx);
		writeExecutionMetadata.clear();
		teardownToolMouseInteraction();
		deactivateGlobalToolRendering(globalToolRendering);
		deactivateLegacyCompactionRendering();
		clearAllAnimations();
	});
}
