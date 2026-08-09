import type { CompactThinkingConfig } from "../feature/compact-thinking.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type DiffIndicatorMode,
	type DiffViewMode,
	type ToolDisplayConfig,
} from "../renderer/tool-diff/index.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CompactStyleMode = "on" | "off";

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	showStartupHeader: boolean;
	scrollStepLines: number;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "claude-code-style.json");

export const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
export const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
export const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
export const DIFF_COLLAPSED_LINES_VALUES = ["12", "24", "36", "48", "80", "120"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
export const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
export const THINKING_PREVIEW_LINES_VALUES = ["0", "1", "3", "5", "10"];
export const THINKING_ANIMATION_INTERVAL_VALUES = ["40", "60", "90", "120", "180"];
/** fullscreen 滚轮步进行数预设。 */
export const SCROLL_STEP_LINES_VALUES = ["1", "2", "3", "5", "10"];
/** Tools commonly toggled in excludeRenderers via the settings panel. */
export const EXCLUDE_RENDERER_CANDIDATES = [
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
	diffViewMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode,
	diffIndicatorMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode,
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	diffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	showStartupHeader: true,
	scrollStepLines: 3,
};

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

export function pickPositiveInt(value: unknown, fallback: number, min = 1, max = 100_000): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

export function pickPositiveNumber(value: unknown, fallback: number, min = 1): number {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export function nearestPreset(value: number, presets: readonly string[]): string {
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
	// mode=compact 已日落：旧配置回退到 on（Claude Code 风格）。
	const migratedMode: CompactStyleMode =
		mode === "on" || mode === "off"
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
	return {
		mode: migratedMode,
		excludeRenderers,
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
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle !== false,
		previewLines: pickPositiveInt(
			source.previewLines,
			DEFAULT_CONFIG.previewLines,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		animationIntervalMs: pickPositiveNumber(
			source.animationIntervalMs,
			DEFAULT_CONFIG.animationIntervalMs,
		),
		showStartupHeader: source.showStartupHeader !== false,
		scrollStepLines: pickPositiveInt(source.scrollStepLines, DEFAULT_CONFIG.scrollStepLines, 1, 50),
	};
}

export function getCompactThinkingConfig(source: Config = config): CompactThinkingConfig {
	return {
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle,
		previewLines: source.previewLines,
		animationIntervalMs: source.animationIntervalMs,
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

export function formatExcludeRenderers(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

export function formatConfigStatus(source: Config = config): string {
	return [
		`mode=${source.mode}`,
		`exclude=[${source.excludeRenderers.join(", ") || "none"}]`,
		`diffView=${source.diffViewMode}`,
		`diffIndicator=${source.diffIndicatorMode}`,
		`diffSplitMin=${source.diffSplitMinWidth}`,
		`diffCollapsed=${source.diffCollapsedLines}`,
		`diffWordWrap=${source.diffWordWrap ? "on" : "off"}`,
		`expandedMax=${source.expandedPreviewMaxLines}`,
		`thinkingTitle=${source.useSummaryTitlesAsThinkingTitle ? "summary" : "default"}`,
		`thinkingPreview=${source.previewLines}`,
		`thinkingAnimation=${source.animationIntervalMs}ms`,
		`startupHeader=${source.showStartupHeader ? "on" : "off"}`,
		`scrollStep=${source.scrollStepLines}`,
	].join(" · ");
}

export let config: Config = loadConfig();

function loadConfig(): Config {
	try {
		const source = existsSync(CONFIG_PATH)
			? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>)
			: {};
		const normalized = normalizeConfig(source);
		if (typeof source.enabled === "boolean" && source.mode !== "on" && source.mode !== "off") {
			try {
				writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
			} catch {
				// A read-only config still uses the migrated in-memory value.
			}
		}
		return normalized;
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** 整体替换配置（default export 的 configOverride 注入路径；导入绑定不可重新赋值）。 */
export function setConfig(next: Config): void {
	config = next;
}
