import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Keybinding,
} from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { isLazyProxyTui } from "../utils/fullscreen-detect.ts";
import { parseSgrMousePackets } from "./mouse-packets.ts";

const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_SHORTCUT = "ctrl+end";

/**
 * 当前安装的 tui 宿主。宿主放本模块（滚动按钮/调度依赖它），
 * 由 mouse-interaction 经 setToolMouseTui 维护；跨模块一律经绑定/setter 访问。
 */
export let toolMouseTui: any = null;
export function setToolMouseTui(tui: any): void {
	toolMouseTui = tui;
}

export let scrollButtonVisible = false;
export let scrollButtonHovered = false;
export let scrollButtonWidget: any = null;
let scrollButtonSyncScheduled = false;

export function setScrollButtonVisible(visible: boolean): void {
	scrollButtonVisible = visible;
}

/** 返回是否发生变化（调用方据此决定是否需要重渲染）。 */
export function setScrollButtonHovered(hovered: boolean): boolean {
	if (hovered === scrollButtonHovered) return false;
	scrollButtonHovered = hovered;
	return true;
}

export function setScrollButtonWidget(widget: any): void {
	scrollButtonWidget = widget;
}

/** teardown 全量清零（visible/hovered/widget/sync 调度）。 */
export function resetScrollButtonState(): void {
	scrollButtonVisible = false;
	scrollButtonHovered = false;
	scrollButtonWidget = null;
	scrollButtonSyncScheduled = false;
}

export function toolMouseInteractionActive(): boolean {
	if (config.mode === "off") return false;
	if (isLazyProxyTui(toolMouseTui)) return true;
	return true;
}

/** 惰性 Proxy 官方 fullscreen（TuiAltScreen）判定。 */
export function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

/** 官方 fullscreen：是否已跟随 transcript 底部（按钮隐藏条件）。 */
export function isFullscreenAtBottom(tui: any): boolean {
	const following = tui.isFollowingOutput ?? tui.getPrimaryScrollView?.()?.isFollowingEnd ?? true;
	return Boolean(following);
}

function formatShortcut(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) =>
			part.length <= 1 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
		)
		.join("+");
}

export function isScrollBottomInput(data: string): boolean {
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
		].some((key) => getKeybindings().matches(data, key as Keybinding))
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

export function hideScrollButton(tui: any): void {
	const changed = scrollButtonVisible || scrollButtonHovered;
	scrollButtonVisible = false;
	scrollButtonHovered = false;
	if (changed) tui.requestRender?.();
}

export function scheduleScrollButtonSync(tui: any, data: string): void {
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

export function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!fullscreenLazyTui(tui) || !toolMouseInteractionActive()) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return")) hideScrollButton(tui);
}

export function renderScrollButton(width: number, theme: any): string[] {
	if (!scrollButtonVisible || !fullscreenLazyTui(toolMouseTui)) return [];
	const shortcut = formatShortcut(SCROLL_BOTTOM_SHORTCUT);
	const label = theme.fg(
		scrollButtonHovered ? "text" : "accent",
		`[ ↓ Back to bottom · ${shortcut} ]`,
	);
	const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
	return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
}
