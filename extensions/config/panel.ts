/**
 * /ccstyle 配置面板 UI。
 *
 * 渲染副作用（applyStyleMode / refreshCurrentTranscript）由 renderer 经
 * CcstylePanelHooks 注入，避免 config → renderer 循环依赖。
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { applyStartupHeader } from "../feature/pi-startup-header.ts";
import type { ToolGroupingHooks } from "../renderer/tool-grouping.ts";
import type { DiffIndicatorMode, DiffViewMode } from "../renderer/tool-diff/index.ts";
import {
	config,
	DEFAULT_CONFIG,
	DIFF_COLLAPSED_LINES_VALUES,
	DIFF_INDICATOR_MODES,
	DIFF_SPLIT_MIN_WIDTH_VALUES,
	DIFF_VIEW_MODES,
	EXCLUDE_RENDERER_CANDIDATES,
	EXPANDED_PREVIEW_MAX_LINES_VALUES,
	formatExcludeRenderers,
	getCompactThinkingConfig,
	nearestPreset,
	pickPositiveInt,
	pickPositiveNumber,
	saveConfig,
	SCROLL_STEP_LINES_VALUES,
	THINKING_ANIMATION_INTERVAL_VALUES,
	THINKING_PREVIEW_LINES_VALUES,
	type CompactStyleMode,
} from "./config.ts";

/** renderer 注入的渲染副作用，面板自身不触碰渲染状态。 */
export type CcstylePanelHooks = {
	applyStyleMode: (mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks) => void;
	refreshCurrentTranscript: (ctx?: any, toolGrouping?: ToolGroupingHooks) => void;
};

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "off") {
		return "Pi native tool rendering. Diff options below still apply independently.";
	}
	return "Claude Code style with rich edit/write diffs. Tune diff options below.";
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
				: `Use Pi native renderer for ${name} instead of Claude Code styling.`,
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
	id: "style" | "editor" | "diff" | "thinking" | "feature";
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

export async function showCcstylePanel(
	ctx: any,
	hooks: CcstylePanelHooks,
	toolGrouping?: ToolGroupingHooks,
	compactThinking?: CompactThinkingController,
): Promise<void> {
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
						hooks.refreshCurrentTranscript(ctx);
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
		const thinkingTitleSetting = {
			id: "useSummaryTitlesAsThinkingTitle",
			label: "Summary title",
			description: "Use the latest provider summary as the active thinking title.",
			currentValue: config.useSummaryTitlesAsThinkingTitle ? "on" : "off",
			values: ["on", "off"],
		};
		const thinkingPreviewSetting = {
			id: "previewLines",
			label: "Preview lines",
			description: "Thinking preview lines; 0 hides the preview body.",
			currentValue: nearestPreset(config.previewLines, THINKING_PREVIEW_LINES_VALUES),
			values: [...THINKING_PREVIEW_LINES_VALUES],
		};
		const thinkingAnimationSetting = {
			id: "animationIntervalMs",
			label: "Animation interval ms",
			description: "Thinking title animation interval for the next thinking run.",
			currentValue: nearestPreset(config.animationIntervalMs, THINKING_ANIMATION_INTERVAL_VALUES),
			values: [...THINKING_ANIMATION_INTERVAL_VALUES],
		};
		const startupHeaderSetting = {
			id: "showStartupHeader",
			label: "Startup header",
			description: config.showStartupHeader
				? "Show the custom startup header (logo + tips) on new sessions."
				: "Use Pi's native startup header instead.",
			currentValue: config.showStartupHeader ? "on" : "off",
			values: ["on", "off"],
		};
		const scrollStepSetting = {
			id: "scrollStepLines",
			label: "Scroll step",
			description: "Mouse wheel scroll lines in fullscreen mode.",
			currentValue: nearestPreset(config.scrollStepLines, SCROLL_STEP_LINES_VALUES),
			values: [...SCROLL_STEP_LINES_VALUES],
		};

		const onSettingChange = (id: string, value: string) => {
			switch (id) {
				case "mode":
					modeSetting.description = modeSettingDescription(value as CompactStyleMode);
					hooks.applyStyleMode(value as CompactStyleMode, ctx, toolGrouping);
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
				case "useSummaryTitlesAsThinkingTitle":
					config.useSummaryTitlesAsThinkingTitle = value === "on";
					break;
				case "previewLines":
					config.previewLines = pickPositiveInt(value, DEFAULT_CONFIG.previewLines, 0);
					break;
				case "animationIntervalMs":
					config.animationIntervalMs = pickPositiveNumber(
						value,
						DEFAULT_CONFIG.animationIntervalMs,
					);
					break;
				case "showStartupHeader":
					config.showStartupHeader = value === "on";
					startupHeaderSetting.description = config.showStartupHeader
						? "Show the custom startup header (logo + tips) on new sessions."
						: "Use Pi's native startup header instead.";
					// 实时切换：on → 自定义 header；off → 官方默认 header。
					applyStartupHeader(ctx);
					break;
				case "scrollStepLines":
					config.scrollStepLines = pickPositiveInt(value, DEFAULT_CONFIG.scrollStepLines, 1, 50);
					break;
				default:
					return;
			}
			saveConfig();
			compactThinking?.updateConfig(getCompactThinkingConfig());
			hooks.refreshCurrentTranscript(ctx);
			ctx.ui.notify(`Updated ${id}: ${value}`, "info");
		};

		const sections: CcstyleSection[] = [
			{
				id: "style",
				label: "Style",
				items: [modeSetting, excludeSetting],
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
			{
				id: "thinking",
				label: "Thinking",
				items: [thinkingTitleSetting, thinkingPreviewSetting, thinkingAnimationSetting],
			},
			{
				id: "feature",
				label: "Feature",
				items: [startupHeaderSetting, scrollStepSetting],
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
