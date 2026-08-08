import { getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasActiveTextPreview, showTextPreview } from "../feature/context.ts";
import { ToolGroupComponent } from "./tool-grouping.ts";
import { config } from "../config/config.ts";
import { isLazyProxyTui } from "../utils/fullscreen-detect.ts";
import { setToolTuiFullscreen } from "./show-more-hint.ts";
import {
	type ExpandedToolIoView,
	getActiveIoViewFrame,
	invalidateIoView,
	isExpandedToolIoView,
	type IoViewFrameState,
	setActiveIoViewFrame,
	type ToolIoSection,
} from "./tool-result.ts";

type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

type FrameToolRender = {
	component: any;
	lines: string[];
	contentBoxLines: number;
};

/** Final painted placement of one outermost tool/group row after parent layout. */
type FrameToolPlacement = {
	component: any;
	componentRow: number;
	lineIndex: number;
	/** Marker-stripped final line text as painted after parent layout. */
	finalLine: string;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

type InteractionRegion = {
	kind: "collapsed-hint" | "expanded-card" | "show-more" | "scroll-bottom";
	row: number;
	startCol: number;
	endCol: number;
	component?: any;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

type InteractionFrame = { regions: InteractionRegion[] };

/** Zero-width APC row marker (like pi CURSOR_MARKER); stripped before terminal output. */
const TOOL_FRAME_MARKER_RE = /_cc:t(\d+):(\d+)/g;
const TOOL_VIEW_MARKER_RE = /_cc:v(\d+):([io])/g;
const toolFrameMarker = (id: number, row: number) => `_cc:t${id}:${row}`;

const TOOL_MOUSE_WIDGET_KEY = "ccstyle-tool-mouse";
const TOOL_MOUSE_MOTION_ENABLE = "\x1b[?1003h\x1b[?1006h";
const TOOL_MOUSE_MOTION_DISABLE = "\x1b[?1003l";
const FULLSCREEN_MOTION_ENABLED = Symbol("ccstyle.fullscreen-motion-enabled");
const TOOL_HOVER_STATE_KEY = Symbol.for("pi.ccstyle.tool-hover-state");
const TOOL_MOUSE_OWNER_KEY = Symbol.for("pi.ccstyle.tool-mouse-owner");
const DEFAULT_TOOL_MOUSE_OWNER = {};
export const TOOL_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_SHORTCUT = "ctrl+end";
export let toolMouseTui: any = null;
let toolMouseUi: any = null;
let toolMouseInputUnsubscribe: (() => void) | null = null;
let toolMouseRenderPatchTui: any = null;
let toolMouseRenderPatchOriginal: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchWrapper: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchState: { active: boolean } | null = null;
let toolMouseRawWrite: ((data: string) => unknown) | null = null;
let toolMouseInstallationOwner: object | null = null;
let fullscreenMotionTerminal: any = null;
let ownsFullscreenMotion = false;
let scrollButtonVisible = false;
let scrollButtonHovered = false;
let scrollButtonWidget: any = null;
let scrollButtonSyncScheduled = false;
let sessionRenderTimer: ReturnType<typeof setTimeout> | null = null;
type SharedToolHoverState = { toolCallId: string | null };
function sharedToolHoverState(): SharedToolHoverState {
	const host = globalThis as any;
	return (host[TOOL_HOVER_STATE_KEY] ??= { toolCallId: null });
}
export let hoveredToolCallId: string | null = sharedToolHoverState().toolCallId;
function setHoveredToolCallId(toolCallId: string | null): void {
	hoveredToolCallId = toolCallId;
	sharedToolHoverState().toolCallId = toolCallId;
}
export function isToolCallHovered(toolCallId: string | null | undefined): boolean {
	return Boolean(toolCallId && sharedToolHoverState().toolCallId === toolCallId);
}
let hoveredToolGroup: ToolGroupComponent | null = null;
let latestInteractionFrame: InteractionFrame = { regions: [] };

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

function stripTerminalSequencesPreservingLayout(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function stripTerminalSequences(value: string): string {
	return stripTerminalSequencesPreservingLayout(value).replace(/\s+/g, " ").trim();
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

function collectToolComponents(component: any, tools: any[], seen = new Set<any>()): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (isToolExecutionComponent(component)) {
		tools.push(component);
		return;
	}
	if (Array.isArray(component.children)) {
		for (const child of component.children) collectToolComponents(child, tools, seen);
	}
	try {
		const mounted = component.getMountedRoots?.();
		if (Array.isArray(mounted)) {
			for (const root of mounted) collectToolComponents(root, tools, seen);
		}
	} catch {
		// renderer 切换中的惰性 Proxy 可能暂时没有 mounted roots。
	}
}

function stripToolFrameMarkers(line: string): string {
	return line.replace(TOOL_FRAME_MARKER_RE, "").replace(TOOL_VIEW_MARKER_RE, "");
}

function extractToolFramePlacements(
	lines: string[],
	idToComponent: Map<number, any>,
	idToView: Map<number, ExpandedToolIoView>,
): { lines: string[]; placements: FrameToolPlacement[] } {
	const placements: FrameToolPlacement[] = [];
	const cleaned = lines.map((line, lineIndex) => {
		const toolMatches = [...line.matchAll(TOOL_FRAME_MARKER_RE)];
		const viewMatches = [...line.matchAll(TOOL_VIEW_MARKER_RE)];
		const finalLine = stripToolFrameMarkers(line);
		let view: ExpandedToolIoView | undefined;
		let section: ToolIoSection | undefined;
		for (const match of viewMatches) {
			const candidate = idToView.get(Number(match[1]));
			if (!candidate) continue;
			view = candidate;
			section = match[2] === "i" ? "input" : "output";
			break;
		}
		for (const match of toolMatches) {
			const component = idToComponent.get(Number(match[1]));
			if (!component) continue;
			placements.push({
				component,
				componentRow: Number(match[2]),
				lineIndex,
				finalLine,
				view,
				section,
			});
		}
		return finalLine;
	});
	return { lines: cleaned, placements };
}

/** Summary markers used by Pi and ccstyle; unlike the trailing hint, these survive truncation. */
const COLLAPSED_TOOL_SUMMARY = /^\s*(?:↳|└|⎿|●|✓|✗|…)/;

function toolMouseInteractionActive(): boolean {
	if (config.mode === "off") return false;
	if (isLazyProxyTui(toolMouseTui)) return true;
	return true;
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

function isScrollNavigationInput(data: string): boolean {
	if (
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		ZENTUI_PAGE_UP_INPUT.test(data) ||
		ZENTUI_PAGE_DOWN_INPUT.test(data) ||
		// 官方 fullscreen viewport 的可滚动键（half-page/prompt/top/bottom）。
		[
			"tui.altScreen.pageUp",
			"tui.altScreen.pageDown",
			"tui.altScreen.halfPageUp",
			"tui.altScreen.halfPageDown",
			"tui.altScreen.previousPrompt",
			"tui.altScreen.nextPrompt",
			"tui.altScreen.top",
			"tui.altScreen.bottom",
		].some((key) => getKeybindings().matches(data, key))
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

function isAtTranscriptBottom(tui: any): boolean {
	// 惰性 Proxy fullscreen：官方 viewport 以 isFollowingOutput 判定是否在底部。
	if (fullscreenLazyTui(tui)) return isFullscreenAtBottom(tui);
	return true;
}

function hideScrollButton(tui: any): void {
	const changed = scrollButtonVisible || scrollButtonHovered;
	scrollButtonVisible = false;
	scrollButtonHovered = false;
	if (changed) tui.requestRender?.();
}

function scheduleScrollButtonSync(tui: any, data: string): void {
	if (
		!fullscreenLazyTui(tui) ||
		!toolMouseInteractionActive() ||
		!isScrollNavigationInput(data) ||
		scrollButtonSyncScheduled
	)
		return;
	scrollButtonSyncScheduled = true;
	const previousLines = tui.previousLines;
	const check = (attempt: number) => {
		scrollButtonSyncScheduled = false;
		if (toolMouseTui !== tui) return;
		// Pi renders on its own frame timer. Inspect the resulting viewport before
		// showing the button so empty or non-scrollable transcripts never flash it.
		const rendered = tui.previousLines !== previousLines;
		// fullscreen 下 isFollowingOutput 是即时状态，无需等待官方帧渲染。
		if (!rendered && attempt < 4 && !fullscreenLazyTui(tui)) {
			scrollButtonSyncScheduled = true;
			const timer = setTimeout(() => check(attempt + 1), 16);
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref: () => void }).unref();
			}
			return;
		}
		const nextVisible = !isAtTranscriptBottom(tui);
		if (nextVisible !== scrollButtonVisible) {
			scrollButtonVisible = nextVisible;
			tui.requestRender?.();
		}
	};
	process.nextTick(() => check(0));
}

function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!fullscreenLazyTui(tui) || !toolMouseInteractionActive()) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return")) hideScrollButton(tui);
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

let hoveredToolIoView: ExpandedToolIoView | null = null;
let hoveredToolIoSection: ToolIoSection | null = null;

function collapsedHintHitbox(line: string): { startCol: number; endCol: number } | null {
	const plain = stripTerminalSequencesPreservingLayout(line);
	const match = /(\([^()\n]* \/ click\)|click to show more|to show more)(?=\)?\s*$)/.exec(plain);
	if (!match?.[1]) return null;
	const startCol = visibleWidth(plain.slice(0, match.index)) + 1;
	return { startCol, endCol: startCol + visibleWidth(match[1]) - 1 };
}

function interactionRegionAt(packet: SgrMousePacket): InteractionRegion | null {
	const matches = latestInteractionFrame.regions.filter(
		(region) =>
			region.row === packet.row && packet.col >= region.startCol && packet.col <= region.endCol,
	);
	return (
		matches.find((region) => region.kind === "show-more") ??
		matches.find((region) => region.kind === "scroll-bottom") ??
		matches.find((region) => region.kind === "collapsed-hint") ??
		matches.find((region) => region.kind === "expanded-card") ??
		null
	);
}

function tryOpenToolIoShowMore(region: InteractionRegion): boolean {
	const ioView = region.view;
	const section = region.section;
	if (!ioView || !section) return false;
	const ui = toolMouseUi;
	if (!ui || typeof ui.custom !== "function") {
		ui?.notify?.("Full preview requires TUI custom UI", "warning");
		return true;
	}
	const title = section === "input" ? "Tool Input" : "Tool Output";
	const content = section === "input" ? ioView.getInputBody() : ioView.getOutputBody();
	void showTextPreview({ ui }, title, content || "(empty)");
	return true;
}

export function setHoveredToolIo(
	view: ExpandedToolIoView | null,
	section: ToolIoSection | null,
): boolean {
	// resultRendererComponent 可能是 Text/第三方 renderer；reload 后也可能残留旧实例。
	const nextView = isExpandedToolIoView(view) ? view : null;
	const nextSection = nextView ? section : null;
	if (nextView === hoveredToolIoView && nextSection === hoveredToolIoSection) return false;
	if (isExpandedToolIoView(hoveredToolIoView)) {
		hoveredToolIoView.setHoveredSection(null);
		invalidateIoView(hoveredToolIoView);
	}
	hoveredToolIoView = nextView;
	hoveredToolIoSection = nextSection;
	if (nextView) {
		nextView.setHoveredSection(nextSection);
		invalidateIoView(nextView);
	}
	return true;
}

export function setHoveredToolGroup(group: ToolGroupComponent | null): boolean {
	if (group === hoveredToolGroup) return false;
	hoveredToolGroup?.setHintHovered(false);
	hoveredToolGroup = group;
	group?.setHintHovered(true);
	return true;
}

function updateToolSummaryHover(tui: any, packet: SgrMousePacket): void {
	if ((packet.code & 32) === 0 || packet.final !== "M") return;
	const region = interactionRegionAt(packet);
	const nextScrollButtonHovered = region?.kind === "scroll-bottom";
	const scrollButtonChanged = nextScrollButtonHovered !== scrollButtonHovered;
	scrollButtonHovered = nextScrollButtonHovered;
	const component = region?.component;
	const nextToolCallId = region?.kind === "collapsed-hint" ? (component?.toolCallId ?? null) : null;
	const nextGroup = component instanceof ToolGroupComponent ? component : null;
	const nextIoView = region?.kind === "show-more" ? (region.view ?? null) : null;
	const nextIoSection = region?.kind === "show-more" ? (region.section ?? null) : null;
	const changed = nextToolCallId !== sharedToolHoverState().toolCallId;
	setHoveredToolCallId(nextToolCallId);
	if (
		scrollButtonChanged ||
		setHoveredToolIo(nextIoView, nextIoSection) ||
		setHoveredToolGroup(nextGroup) ||
		changed
	)
		tui.requestRender?.();
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const region = interactionRegionAt(packet);
	if (!region) return false;
	if (region.kind === "scroll-bottom") return false;
	if (region.kind === "show-more") return tryOpenToolIoShowMore(region);
	const component = region.component;
	if (!component) return false;
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	if (region.kind === "expanded-card") {
		component.setExpanded(false);
		setHoveredToolCallId(null);
		setHoveredToolGroup(null);
		setHoveredToolIo(null, null);
		component.invalidate?.();
		tui.requestRender?.();
		return true;
	}
	component.setExpanded(true);
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredToolIo(null, null);
	component.invalidate?.();
	tui.requestRender?.();
	return true;
}

function renderScrollButton(width: number, theme: any): string[] {
	if (!scrollButtonVisible || !fullscreenLazyTui(toolMouseTui)) return [];
	const shortcut = formatShortcut(SCROLL_BOTTOM_SHORTCUT);
	const label = theme.fg(
		scrollButtonHovered ? "text" : "accent",
		`[ ↓ Back to bottom · ${shortcut} ]`,
	);
	const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
	return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
}

/** 惰性 Proxy 官方 fullscreen（TuiAltScreen）判定。 */
function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

function officialFullscreenHasAllMotion(): boolean {
	const term = process.env.TERM?.toLowerCase() ?? "";
	return !(
		process.env.TMUX !== undefined ||
		process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
}

/**
 * hover 依赖 DECSET 1003。官方 fullscreen 在 multiplexer 下只开 1002，
 * 因此扩展需在每个实际 renderer 上补开（Symbol 经惰性 Proxy 落到当前实例）。
 */
function ensureFullscreenToolMouseMotion(tui: any): void {
	setToolTuiFullscreen(fullscreenLazyTui(tui));
	if (!fullscreenLazyTui(tui)) {
		releaseFullscreenToolMouseMotion(tui);
		return;
	}
	// 面板改 scrollStepLines 后，下一帧渲染即同步（restore 仍按 original 恢复）。
	if (typeof tui.wheelScrollLines === "number" && tui.wheelScrollLines !== config.scrollStepLines) {
		tui.wheelScrollLines = config.scrollStepLines;
	}
	if (
		!toolMouseInteractionActive() ||
		tui.mouseEnabled === false ||
		tui.altScreenActive === false ||
		tui[FULLSCREEN_MOTION_ENABLED]
	) {
		return;
	}
	try {
		tui.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		tui[FULLSCREEN_MOTION_ENABLED] = true;
		fullscreenMotionTerminal = tui.terminal;
		ownsFullscreenMotion = !officialFullscreenHasAllMotion();
	} catch {
		// renderer 可能正在切换或终端已经关闭。
	}
}

function releaseFullscreenToolMouseMotion(tui?: any): void {
	try {
		if (tui?.[FULLSCREEN_MOTION_ENABLED]) tui[FULLSCREEN_MOTION_ENABLED] = false;
	} catch {
		// 惰性 Proxy 可能已经切到另一个 renderer。
	}
	const terminal = fullscreenMotionTerminal;
	const shouldDisable = ownsFullscreenMotion;
	fullscreenMotionTerminal = null;
	ownsFullscreenMotion = false;
	try {
		if (shouldDisable) terminal?.write?.(TOOL_MOUSE_MOTION_DISABLE);
	} catch {
		// renderer 可能正在切换或终端已经关闭。
	}
}

/** 官方 fullscreen：是否已跟随 transcript 底部（按钮隐藏条件）。 */
function isFullscreenAtBottom(tui: any): boolean {
	const following = tui.isFollowingOutput ?? tui.getPrimaryScrollView?.()?.isFollowingEnd ?? true;
	return Boolean(following);
}

const FULLSCREEN_VIEWPORT_PATCH = Symbol("ccstyle.fullscreen-viewport-patch");
const FULLSCREEN_WHEEL_SCROLL_ORIGINAL = Symbol("ccstyle.fullscreen-wheel-scroll-original");

/** 布局树点查询：返回 (x,y) 处最深含行 leaf box（屏幕行 → 组件局部行）。 */
function fullscreenLeafAt(
	layout: any,
	x: number,
	y: number,
): { box: any; localRow: number } | null {
	const root = layout?.root;
	if (!root) return null;
	let best: { box: any; localRow: number } | null = null;
	let bestDepth = -1;
	const visit = (box: any, depth: number) => {
		if (!box) return;
		const clip = box.clip;
		if (!clip || x < clip.x || x >= clip.x + clip.width || y < clip.y || y >= clip.y + clip.height)
			return;
		const isLeaf = !Array.isArray(box.children) || box.children.length === 0;
		if (
			isLeaf &&
			y >= box.rect.y &&
			y < box.rect.y + Math.max(1, box.rect.height) &&
			depth > bestDepth
		) {
			best = { box, localRow: Math.max(0, y - box.rect.y) };
			bestDepth = depth;
		}
		for (const child of box.children ?? []) visit(child, depth + 1);
	};
	visit(root, 0);
	return best;
}

/** leaf 自身不带 scrollView；内容宽度由最近的 scroll 祖先决定。 */
function fullscreenContentWidth(box: any, terminalWidth: number): number {
	for (let current = box; current; current = current.parent) {
		if (typeof current.scrollView?.getContentWidth === "function") {
			return Math.max(1, current.scrollView.getContentWidth(terminalWidth));
		}
	}
	return terminalWidth;
}

/** 点击列是否为官方滚动条列（放行官方拖动）。 */
function isScrollbarColumnAt(layout: any, x: number): boolean {
	let hit = false;
	const visit = (box: any) => {
		if (hit || !box) return;
		if (box.scrollView?.isScrollbarVisible && x === box.rect.x + box.rect.width - 1) {
			hit = true;
			return;
		}
		for (const child of box.children ?? []) visit(child);
	};
	visit(layout?.root);
	return hit;
}

type ComponentRowHit = {
	component: any;
	row: number;
	/** 内部工具命中时所属的展开 group；普通卡点击仍折叠整个 group。 */
	group?: ToolGroupComponent;
};

/**
 * 布局 leaf box 的组件通常是容器（documentContainer/dock 容器等），工具卡与
 * widget 在其 children 内。按局部行遍历组件树，定位实际命中的子组件。
 */
function componentAtLocalRow(
	component: any,
	localRow: number,
	width: number,
): ComponentRowHit | null {
	if (component instanceof ToolGroupComponent) {
		// 展开的 group：头两行（空行 + 头行）归 group，其余行映射到内部工具。
		const child = component.childAtRow(localRow, width);
		return child ? { ...child, group: component } : { component, row: localRow };
	}
	if (isToolExecutionComponent(component)) {
		return { component, row: localRow };
	}
	if (component === scrollButtonWidget) {
		return { component, row: localRow };
	}
	if (!Array.isArray(component.children)) return null;
	let offset = 0;
	for (const child of component.children) {
		let lines: string[] = [];
		try {
			const rendered = child.render?.(width);
			if (Array.isArray(rendered)) lines = rendered.map((line) => String(line));
		} catch {
			lines = [];
		}
		if (localRow < offset + lines.length) {
			return (
				componentAtLocalRow(child, localRow - offset, width) ?? {
					component: child,
					row: localRow - offset,
				}
			);
		}
		offset += lines.length;
	}
	return null;
}

/** fullscreen single-expand：group 作为整体，不继续递归其内部工具。 */
function collectFullscreenToolCards(component: any, out: any[], seen = new Set<any>()): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (isToolExecutionComponent(component) || component instanceof ToolGroupComponent) {
		out.push(component);
		return;
	}
	if (!Array.isArray(component.children)) return;
	for (const child of component.children) collectFullscreenToolCards(child, out, seen);
}

/**
 * 官方 fullscreen 工具卡点击：collapsed hint 点击展开
 * （有且仅保持一个展开：展开前收起其他工具卡），expanded 整卡二次点击收起，
 * 截断头 show-more 打开全量预览；回到底部按钮 scrollToBottom。
 * 滚动条列、含 OSC8 链接行、非工具区域放行官方。
 */
function handleFullscreenToolClick(tui: any, packet: SgrMousePacket): boolean {
	const layout = tui.currentLayout;
	if (!layout?.root) return false;
	// 官方事件坐标 0-based；SGR packet 1-based。
	const x = packet.col - 1;
	const y = packet.row - 1;
	if (isScrollbarColumnAt(layout, x)) return false;
	const hit = fullscreenLeafAt(layout, x, y);
	if (!hit) return false;
	const width = Math.max(1, Number(tui.terminal?.columns) || 80);
	// 布局树用 scroll 的 contentWidth 渲染内容（滚动条占用时 = width-1）；
	// 行号定位必须用同一宽度，否则换行差异导致组件行错位。
	const contentWidth = fullscreenContentWidth(hit.box, width);
	const target = componentAtLocalRow(hit.box.component, hit.localRow, contentWidth);
	if (!target) return false;
	const component = target.component;
	const card = target.group ?? component;
	// 回到底部按钮：按组件引用命中，不依赖渲染行缓存。
	if (scrollButtonVisible && component === scrollButtonWidget) {
		tui.scrollToBottom?.();
		hideScrollButton(tui);
		return true;
	}
	const line = hit.box.lines?.[hit.localRow];
	if (typeof line !== "string" || /\x1b]8;[^;]*;/.test(line)) return false;
	const isTool = isToolExecutionComponent(component);
	const isGroup = component instanceof ToolGroupComponent;
	if (!isTool && !isGroup) return false;
	if (!component.expanded) {
		// collapsed 仅按钮文本可展开，不能把同一行正文/留白变成点击区。
		const hint = collapsedHintHitbox(line);
		if (!hint || packet.col < hint.startCol || packet.col > hint.endCol) return false;
		// single-expand：展开前收起其他已展开工具卡/group。
		const others: any[] = [];
		collectFullscreenToolCards(hit.box.component, others);
		for (const other of others) {
			if (other !== component && other.expanded) {
				other.setExpanded(false);
				other.invalidate?.();
			}
		}
		component.setExpanded(true);
	} else {
		// 普通工具截断头 show-more：打开全量预览（不收起）。
		const view = isTool ? component.resultRendererComponent : null;
		if (isExpandedToolIoView(view)) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const section = view.matchShowMoreLine(plain);
			if (section) {
				const box = view.showMoreHitbox(plain);
				if (box && x + 1 >= box.startCol && x + 1 <= box.endCol) {
					return tryOpenToolIoShowMore({
						kind: "show-more",
						row: 0,
						startCol: box.startCol,
						endCol: box.endCol,
						component,
						view,
						section,
					});
				}
			}
		}
		// 整卡二次点击：内部工具仍归所属 group，保持整体展开/收起语义。
		card.setExpanded(false);
	}
	// 点击后清 hover 高亮。
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredToolIo(null, null);
	card.invalidate?.();
	tui.requestRender?.();
	return true;
}

/** hover 与点击共用组件定位；同一布局下按容器/宽度/行缓存，避免 motion 重复渲染。 */
let fullscreenHoverCacheLayout: unknown = null;
let fullscreenHoverComponentCache = new WeakMap<object, Map<string, ComponentRowHit | null>>();

function cachedFullscreenComponentAtRow(
	layout: any,
	container: any,
	row: number,
	width: number,
): ComponentRowHit | null {
	if (!container || typeof container !== "object") return null;
	if (fullscreenHoverCacheLayout !== layout) {
		fullscreenHoverCacheLayout = layout;
		fullscreenHoverComponentCache = new WeakMap();
	}
	let rows = fullscreenHoverComponentCache.get(container);
	if (!rows) {
		rows = new Map();
		fullscreenHoverComponentCache.set(container, rows);
	}
	const key = `${width}:${row}`;
	if (rows.has(key)) return rows.get(key) ?? null;
	const hit = componentAtLocalRow(container, row, width);
	rows.set(key, hit);
	return hit;
}

/** fullscreen 鼠标悬停目标。 */
type FullscreenHoverTarget =
	| { kind: "button" }
	| { kind: "group"; component: ToolGroupComponent }
	| {
			kind: "tool";
			component: any;
			view: ExpandedToolIoView | null;
			section: ToolIoSection | null;
	  };

/**
 * fullscreen 悬停高亮：collapsed 卡 [click to show more] hint、
 * expanded 卡截断头 show-more、回到底部按钮。motion 不 consume，官方链照常。
 */
function handleFullscreenToolHover(tui: any, packet: SgrMousePacket): void {
	if (packet.final !== "M") return;
	const layout = tui.currentLayout;
	if (!layout?.root) return;
	const x = packet.col - 1;
	const y = packet.row - 1;
	let target: FullscreenHoverTarget | null = null;
	const hit = fullscreenLeafAt(layout, x, y);
	if (hit) {
		const line = hit.box.lines?.[hit.localRow];
		// 回到底部按钮：渲染行文本 + 列区间识别（零组件树开销）。
		if (typeof line === "string" && scrollButtonVisible && line.includes("[ ↓")) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const idx = plain.indexOf("[ ↓");
			if (idx >= 0 && x >= idx && x <= idx + plain.length - 1) {
				target = { kind: "button" };
			}
		} else if (typeof line === "string" && !/\x1b]8;/.test(line)) {
			const width = Math.max(1, Number(tui.terminal?.columns) || 80);
			const contentWidth = fullscreenContentWidth(hit.box, width);
			// 与点击共用同一定位算法，避免 hover 自建行段与真实组件树错位。
			const componentHit = cachedFullscreenComponentAtRow(
				layout,
				hit.box.component,
				hit.localRow,
				contentWidth,
			);
			const component = componentHit?.component;
			const hintBox = collapsedHintHitbox(line);
			const overHint = Boolean(
				hintBox && packet.col >= hintBox.startCol && packet.col <= hintBox.endCol,
			);
			if (component instanceof ToolGroupComponent) {
				if (overHint) target = { kind: "group", component };
			} else if (isToolExecutionComponent(component)) {
				let view: ExpandedToolIoView | null = null;
				let section: ToolIoSection | null = null;
				if (component.expanded) {
					const resultView = component.resultRendererComponent;
					if (isExpandedToolIoView(resultView)) {
						view = resultView;
						const plain = stripTerminalSequencesPreservingLayout(line);
						const candidate = view.matchShowMoreLine(plain);
						if (candidate) {
							const box = view.showMoreHitbox(plain);
							if (box && x + 1 >= box.startCol && x + 1 <= box.endCol) {
								section = candidate;
							}
						}
					}
					target = { kind: "tool", component, view, section };
				} else if (overHint) {
					target = { kind: "tool", component, view, section };
				}
			}
		}
	}
	applyFullscreenHover(tui, target);
}

/** 悬停状态变化才触发渲染（motion 事件密集，状态不变跳过）。 */
function applyFullscreenHover(tui: any, target: FullscreenHoverTarget | null): void {
	let changed = false;
	const nextCallId =
		target?.kind === "tool" && !target.component.expanded
			? (target.component.toolCallId ?? null)
			: null;
	if (nextCallId !== sharedToolHoverState().toolCallId) {
		setHoveredToolCallId(nextCallId);
		changed = true;
	}
	const nextGroup = target?.kind === "group" ? target.component : null;
	if (setHoveredToolGroup(nextGroup)) changed = true;
	const nextView = target?.kind === "tool" ? target.view : null;
	const nextSection = target?.kind === "tool" ? target.section : null;
	if (setHoveredToolIo(nextView, nextSection)) changed = true;
	const nextButton = target?.kind === "button";
	if (nextButton !== scrollButtonHovered) {
		scrollButtonHovered = nextButton;
		changed = true;
	}
	if (changed) tui.requestRender?.();
}

/**
 * 实例级包装 TuiAltScreen.handleViewportInput（惰性 Proxy 安全）：
 * 原型方法取 original（绕开 proxy 函数包装），实例 own property 装 wrapper
 * （constructor arrow 动态查找命中）。仅在 fullscreen 且无 overlay 时先消费
 * 工具卡左键点击，其余全部放行官方 selection/scrollbar/URL/键盘链。
 */
function patchFullscreenViewportInput(tui: any): void {
	if (tui[FULLSCREEN_VIEWPORT_PATCH] || !isLazyProxyTui(tui)) return;
	const proto = Object.getPrototypeOf(tui);
	const original = proto?.handleViewportInput;
	if (typeof original !== "function") return;
	// 官方原生 routeWheel 已完整处理嵌套 ScrollView；只调整默认步进（config.scrollStepLines）。
	if (typeof tui.wheelScrollLines === "number") {
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = tui.wheelScrollLines;
		tui.wheelScrollLines = config.scrollStepLines;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = true;
	tui.handleViewportInput = function (this: any, data: string) {
		if (toolMouseInteractionActive() && tui.mode === "fullscreen") {
			// 滚动输入（wheel/pageUp/end 等）后同步回到底部按钮显隐；
			// 官方 viewport 会消费键盘，扩展监听器无法补偿，必须在这里调度。
			scheduleScrollButtonSync(tui, data);
			const packets = parseSgrMousePackets(data);
			// 官方 fullscreen 会消费全部鼠标；文本预览 overlay 活动时放行给 focused
			// custom component，使 [esc] 点击和滚轮可用。
			if (packets && tui.hasOverlay?.() && hasActiveTextPreview()) return undefined;
			if (packets && !tui.hasOverlay?.()) {
				for (const packet of packets) {
					if (isSgrLeftPress(packet) && handleFullscreenToolClick(tui, packet)) {
						return { consume: true };
					}
					if ((packet.code & 32) !== 0 && packet.final === "M") {
						handleFullscreenToolHover(tui, packet);
					}
				}
			}
		}
		return Reflect.apply(original, this, [data]);
	};
}

function restoreFullscreenViewportInput(tui: any): void {
	if (!tui || !tui[FULLSCREEN_VIEWPORT_PATCH]) return;
	const proto = Object.getPrototypeOf(tui);
	if (typeof proto?.handleViewportInput === "function") {
		tui.handleViewportInput = proto.handleViewportInput;
	}
	const originalWheelScrollLines = tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL];
	if (typeof originalWheelScrollLines === "number") {
		tui.wheelScrollLines = originalWheelScrollLines;
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = undefined;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = false;
}

function restoreToolMouseRenderPatch(): void {
	if (toolMouseRenderPatchState) toolMouseRenderPatchState.active = false;
	if (
		toolMouseRenderPatchTui &&
		toolMouseRenderPatchOriginal &&
		toolMouseRenderPatchTui.doRender === toolMouseRenderPatchWrapper
	) {
		toolMouseRenderPatchTui.doRender = toolMouseRenderPatchOriginal;
	}
	toolMouseRenderPatchTui = null;
	toolMouseRenderPatchOriginal = null;
	toolMouseRenderPatchWrapper = null;
	toolMouseRenderPatchState = null;
	toolMouseRawWrite = null;
	latestInteractionFrame = { regions: [] };
}

function buildInteractionFrame(
	tui: any,
	renderedTools: FrameToolRender[],
	placements: FrameToolPlacement[],
): InteractionFrame {
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	// native: full buffer; map with the post-doRender previousViewportTop.
	const lineIndexToScreenRow = (lineIndex: number) =>
		lineIndex - (Number(tui?.previousViewportTop) || 0) + 1;
	const visibleRows = Math.max(1, Number(tui?.terminal?.rows) || Number.POSITIVE_INFINITY);
	const regions: InteractionRegion[] = [];
	const renderedByComponent = new Map<any, FrameToolRender>();
	for (const rendered of renderedTools) renderedByComponent.set(rendered.component, rendered);
	const placementsByComponent = new Map<any, FrameToolPlacement[]>();
	for (const placement of placements) {
		const list = placementsByComponent.get(placement.component) ?? [];
		list.push(placement);
		placementsByComponent.set(placement.component, list);
	}
	for (const [component, componentPlacements] of placementsByComponent) {
		const rendered = renderedByComponent.get(component);
		if (!rendered) continue;
		for (const placement of componentPlacements) {
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow < 1 || finalRow > visibleRows) continue;
			// Hit columns come from the final painted line (parent may prefix/transform).
			const line = placement.finalLine;
			if (!component.expanded) {
				const box = collapsedHintHitbox(line);
				if (box && COLLAPSED_TOOL_SUMMARY.test(stripTerminalSequences(line))) {
					regions.push({ kind: "collapsed-hint", row: finalRow, ...box, component });
				}
				continue;
			}
			if (placement.view && placement.section) {
				const plain = stripTerminalSequencesPreservingLayout(line);
				const box = placement.view.showMoreHitbox(plain);
				if (box) {
					regions.push({
						kind: "show-more",
						row: finalRow,
						...box,
						component,
						view: placement.view,
						section: placement.section,
					});
				}
			}
		}
		if (!component.expanded) continue;
		let cardStart = 0;
		if (!(component instanceof ToolGroupComponent)) {
			const box = component.contentBox;
			if (!box || !Array.isArray(component.children) || !component.children.includes(box)) {
				continue;
			}
			if (!rendered.contentBoxLines) continue;
			cardStart = Math.max(0, rendered.lines.length - rendered.contentBoxLines);
		}
		for (const placement of componentPlacements) {
			if (placement.componentRow < cardStart) continue;
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow >= 1 && finalRow <= visibleRows) {
				regions.push({
					kind: "expanded-card",
					row: finalRow,
					startCol: 1,
					endCol: width,
					component,
				});
			}
		}
	}
	return { regions };
}

/**
 * 临时包装 outermost 工具/组件的 render 注入零宽 marker，返回待 restore 列表。
 * 调用方必须用 restoreRenderOverride 立即还原（同一次渲染内有效）。
 */
function wrapToolRendersForFrame(
	outermost: any[],
	renderedTools: FrameToolRender[],
	idToComponent: Map<number, any>,
): Array<{ target: any; descriptor?: PropertyDescriptor }> {
	const restores: Array<{ target: any; descriptor?: PropertyDescriptor }> = [];
	let nextId = 0;
	try {
		for (const component of outermost) {
			const originalRender = component.render;
			if (typeof originalRender !== "function") continue;
			const id = nextId++;
			idToComponent.set(id, component);
			const wrappedRender = function (this: any, ...renderArgs: any[]) {
				let contentBoxLines = 0;
				const box = component.contentBox;
				let boxRestore: { target: any; descriptor?: PropertyDescriptor } | undefined;
				if (
					box &&
					Array.isArray(component.children) &&
					component.children.includes(box) &&
					typeof box.render === "function"
				) {
					const boxOriginal = box.render;
					const boxWrapped = function (this: any, ...boxArgs: any[]) {
						const boxLines = Reflect.apply(boxOriginal, this, boxArgs);
						if (Array.isArray(boxLines)) contentBoxLines = boxLines.length;
						return boxLines;
					};
					const boxDescriptor = defineRenderOverride(box, boxWrapped);
					if (boxDescriptor !== undefined || box.render === boxWrapped) {
						boxRestore = { target: box, descriptor: boxDescriptor };
					}
				}
				try {
					const lines = Reflect.apply(originalRender, this, renderArgs);
					if (!Array.isArray(lines)) return lines;
					renderedTools.push({
						component,
						lines: lines.map((line) => String(line)),
						contentBoxLines,
					});
					return lines.map((line, row) => `${line}${toolFrameMarker(id, row)}`);
				} finally {
					if (boxRestore) restoreRenderOverride(boxRestore.target, boxRestore.descriptor);
				}
			};
			const descriptor = defineRenderOverride(component, wrappedRender);
			if (descriptor !== undefined || component.render === wrappedRender) {
				restores.push({ target: component, descriptor });
			}
		}
		return restores;
	} catch (error) {
		for (const { target, descriptor } of restores.reverse()) {
			restoreRenderOverride(target, descriptor);
		}
		throw error;
	}
}

function defineRenderOverride(
	target: any,
	wrapped: (...args: any[]) => any,
): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(target, "render");
	try {
		Object.defineProperty(
			target,
			"render",
			descriptor && "value" in descriptor
				? { ...descriptor, value: wrapped }
				: {
						configurable: true,
						enumerable: descriptor?.enumerable ?? false,
						writable: true,
						value: wrapped,
					},
		);
		return descriptor;
	} catch {
		return undefined;
	}
}

function restoreRenderOverride(target: any, descriptor: PropertyDescriptor | undefined): void {
	try {
		if (descriptor) Object.defineProperty(target, "render", descriptor);
		else delete target.render;
	} catch {
		// Keep restoring siblings after a hostile descriptor change.
	}
}

function patchToolMouseMotionAfterRender(tui: any): void {
	// Same tui is not enough: footer/compositor rebuild may replace doRender under us.
	if (
		toolMouseRenderPatchTui === tui &&
		toolMouseRenderPatchState?.active &&
		tui.doRender === toolMouseRenderPatchWrapper
	) {
		return;
	}
	// 0.84+ 惰性 Proxy：捕获 doRender 会解析到 wrapper 自身（无限递归），跳过。
	if (isLazyProxyTui(tui)) return;
	restoreToolMouseRenderPatch();
	const original = tui?.doRender;
	const terminal = tui?.terminal;
	const rawWrite = typeof terminal?.write === "function" ? terminal.write : undefined;
	if (typeof original !== "function") return;

	toolMouseRawWrite = rawWrite ? (data) => Reflect.apply(rawWrite, terminal, [data]) : null;
	const patchState = { active: true };
	const wrapper = function (this: any, ...args: any[]) {
		if (!patchState.active) return Reflect.apply(original, this, args);
		const renderedTools: FrameToolRender[] = [];
		const idToComponent = new Map<number, any>();
		const frame: IoViewFrameState = {
			viewIds: new Map(),
			idToView: new Map(),
			nextId: 0,
		};
		const outermost: any[] = [];
		collectToolComponents(this, outermost);
		const restores = wrapToolRendersForFrame(outermost, renderedTools, idToComponent);
		let placements: FrameToolPlacement[] = [];
		const originalTuiRender = typeof this.render === "function" ? this.render : null;
		let tuiRenderDescriptor: PropertyDescriptor | undefined;
		let sawTuiRender = false;
		if (originalTuiRender) {
			const wrappedTuiRender = function (this: any, ...renderArgs: any[]) {
				const lines = Reflect.apply(originalTuiRender, this, renderArgs);
				if (!Array.isArray(lines)) return lines;
				sawTuiRender = true;
				const extracted = extractToolFramePlacements(
					lines.map((line) => String(line)),
					idToComponent,
					frame.idToView,
				);
				placements = extracted.placements;
				return extracted.lines;
			};
			tuiRenderDescriptor = defineRenderOverride(this, wrappedTuiRender);
		}
		let succeeded = false;
		const previousFrame = getActiveIoViewFrame();
		setActiveIoViewFrame(frame);
		try {
			const result = Reflect.apply(original, this, args);
			succeeded = true;
			// Test harnesses may paint via doRender without tui.render; recover markers there.
			if (!sawTuiRender && Array.isArray(this.previousLines)) {
				const extracted = extractToolFramePlacements(
					this.previousLines.map((line: unknown) => String(line)),
					idToComponent,
					frame.idToView,
				);
				this.previousLines = extracted.lines;
				placements = extracted.placements;
			}
			if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
			return result;
		} finally {
			setActiveIoViewFrame(previousFrame);
			if (originalTuiRender) restoreRenderOverride(this, tuiRenderDescriptor);
			for (const { target, descriptor } of restores.reverse()) {
				restoreRenderOverride(target, descriptor);
			}
			if (succeeded) {
				latestInteractionFrame = buildInteractionFrame(this, renderedTools, placements);
			}
		}
	};
	try {
		tui.doRender = wrapper;
	} catch {
		toolMouseRawWrite = null;
		return;
	}
	toolMouseRenderPatchTui = tui;
	toolMouseRenderPatchOriginal = original;
	toolMouseRenderPatchWrapper = wrapper;
	toolMouseRenderPatchState = patchState;
	if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
}

function handleToolMouseInput(data: string): { consume: true } | undefined {
	if (!toolMouseTui) return undefined;
	// 惰性 Proxy fullscreen：鼠标由 handleViewportInput 包装消费（官方链之前），
	// 此处只处理键盘（鼠标事件在官方 listener 已被 consume，到不了这里）。
	if (fullscreenLazyTui(toolMouseTui)) {
		scheduleScrollButtonSync(toolMouseTui, data);
		if (isScrollBottomInput(data)) {
			toolMouseTui.scrollToBottom?.();
			hideScrollButton(toolMouseTui);
			return { consume: true };
		}
		return undefined;
	}
	updateScrollButtonFromInput(toolMouseTui, data);
	// Off mode restores native input: wheel keeps scrolling through Pi's normal
	// dispatcher, while hover/click affordances are entirely inactive.
	if (!toolMouseInteractionActive()) return undefined;
	const packets = parseSgrMousePackets(data);
	if (!packets) {
		scheduleScrollButtonSync(toolMouseTui, data);
		return undefined;
	}

	let consumed = false;
	for (const packet of packets) {
		updateToolSummaryHover(toolMouseTui, packet);
		if (!isSgrLeftPress(packet)) continue;
		if (toggleToolAtMouseClick(toolMouseTui, packet)) {
			consumed = true;
		}
	}

	// Let scrolling, motion, release, and clicks outside tool results reach the
	// normal TUI input chain (including other extensions such as pi-zentui).
	scheduleScrollButtonSync(toolMouseTui, data);
	return consumed ? { consume: true } : undefined;
}

export function teardownToolMouseInteraction(
	owner: object = toolMouseInstallationOwner ?? DEFAULT_TOOL_MOUSE_OWNER,
): void {
	const host = globalThis as any;
	if (host[TOOL_MOUSE_OWNER_KEY] && host[TOOL_MOUSE_OWNER_KEY] !== owner) return;
	if (sessionRenderTimer) {
		clearTimeout(sessionRenderTimer);
		sessionRenderTimer = null;
	}
	toolMouseInputUnsubscribe?.();
	toolMouseInputUnsubscribe = null;
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredToolIo(null, null);
	try {
		if (isLazyProxyTui(toolMouseTui)) releaseFullscreenToolMouseMotion(toolMouseTui);
		else toolMouseTui?.terminal?.write?.(TOOL_MOUSE_DISABLE);
	} catch {
		// The terminal may already be closed during shutdown.
	}
	try {
		toolMouseUi?.setWidget?.(TOOL_MOUSE_WIDGET_KEY, undefined);
	} catch {
		// The UI context may already have been reset during /reload.
	}
	restoreToolMouseRenderPatch();
	restoreFullscreenViewportInput(toolMouseTui);
	scrollButtonVisible = false;
	scrollButtonHovered = false;
	scrollButtonWidget = null;
	scrollButtonSyncScheduled = false;
	toolMouseTui = null;
	toolMouseUi = null;
	if (host[TOOL_MOUSE_OWNER_KEY] === owner) delete host[TOOL_MOUSE_OWNER_KEY];
	if (toolMouseInstallationOwner === owner) toolMouseInstallationOwner = null;
}

/** off 模式清理：清空 hover 与回到底部按钮状态（跨模块 rebind 统一经由此函数）。 */
export function resetToolHoverState(): void {
	setHoveredToolCallId(null);
	scrollButtonVisible = false;
	scrollButtonHovered = false;
	releaseFullscreenToolMouseMotion(toolMouseTui);
}

export function installToolMouseInteraction(
	ctx: any,
	owner: object = DEFAULT_TOOL_MOUSE_OWNER,
): void {
	teardownToolMouseInteraction(toolMouseInstallationOwner ?? owner);
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.onTerminalInput !== "function" || typeof ctx.ui?.setWidget !== "function")
		return;

	toolMouseInstallationOwner = owner;
	(globalThis as any)[TOOL_MOUSE_OWNER_KEY] = owner;
	setHoveredToolCallId(null);
	toolMouseUi = ctx.ui;
	// 0.84+ 的 tui 是惰性 Proxy：regular 保留原生 scrollback；fullscreen
	// 由官方 LayoutFrame 命中，并由扩展补齐 hover 所需的 all-motion 上报。
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		toolMouseTui = tui;
		setToolTuiFullscreen(fullscreenLazyTui(tui));
		if (isLazyProxyTui(tui)) {
			patchFullscreenViewportInput(tui);
			ensureFullscreenToolMouseMotion(tui);
			scrollButtonWidget = {
				render: (width: number) => {
					patchFullscreenViewportInput(tui);
					ensureFullscreenToolMouseMotion(tui);
					return renderScrollButton(width, theme);
				},
				invalidate() {},
			};
			return scrollButtonWidget;
		}
		// Wrap doRender to capture the live frame for tool click/hover mapping.
		patchToolMouseMotionAfterRender(tui);
		if (toolMouseInteractionActive()) tui?.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		const widget = {
			render: (width: number) => renderScrollButton(width, theme),
			invalidate() {},
		};
		scrollButtonWidget = widget;
		return widget;
	});
	toolMouseInputUnsubscribe = ctx.ui.onTerminalInput(handleToolMouseInput);
}

function refreshToolRendererComponents(tui: any): void {
	const tools: any[] = [];
	collectToolComponents(tui, tools);
	for (const tool of tools) tool.invalidate?.();
}

export function scheduleSessionRender(refresh?: () => void): void {
	const tui = toolMouseTui;
	if (!tui || typeof tui.requestRender !== "function") return;
	if (sessionRenderTimer) clearTimeout(sessionRenderTimer);
	// Restored transcripts are populated at different points for startup, reload,
	// and session replacement. Repaint after session_start and the surrounding UI
	// rebuild finish so messages are not left hidden until the next terminal input.
	sessionRenderTimer = setTimeout(() => {
		sessionRenderTimer = null;
		if (toolMouseTui !== tui) return;
		patchToolMouseMotionAfterRender(tui);
		refreshToolRendererComponents(tui);
		refresh?.();
		tui.requestRender(true);
	}, 0);
}
