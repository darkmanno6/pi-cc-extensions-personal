import { VERSION, type AppKeybinding } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
type StyledPart = {
	raw: string;
	styled: string;
};

// 官方 install.sh 静态 logo（4 行原样，短行补尾随空格统一到 8 列）+ 底部空行补到 5 行，
// 与右侧 tips 行数等高；统一使用主题 accent 纯色
const LOGO_LINES = ["██████  ", "██  ██  ", "████  ██", "██    ██", "        "];

// hero 文案（单行，替换原生 header 的 "Pi can explain..." 默认位置）
const HERO_PREFIX = "There are many agent harnesses, but this one is ";
const HERO_HIGHLIGHT = "yours";
const HERO_SUFFIX = ".";

// 左右双栏布局：左侧 logo(5 行)，右侧原生提示(5 行)
const TWO_COL_GAP = 2;
// 窄于该宽度回退为垂直堆叠（logo + hero）
const TWO_COL_MIN_WIDTH = 48;
const HEADER_HANDOFF_TIMEOUT_MS = 1500;
const HEADER_HANDOFF_TIMER = Symbol.for("pi.ccstyle.startup-header-handoff-timer");
const HEADER_OWNER = Symbol.for("pi.ccstyle.startup-header-owner");

const LOGO_BLOCK_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));
// 左栏宽度 = logo 宽，右侧栏从该宽度后开始
const LEFT_COLUMN_WIDTH = LOGO_BLOCK_WIDTH;

function getVisibleLength(text: string): number {
	return [...stripAnsi(text)].length;
}

function createCenteredBlockLine(text: string, width: number, blockWidth: number): string {
	const leftPadding = Math.max(0, Math.floor((width - blockWidth) / 2));
	return `${" ".repeat(leftPadding)}${text}`;
}

function createCenteredStyledLine(parts: StyledPart[], width: number): string {
	const rawText = parts.map((part) => part.raw).join("");
	const leftPadding = Math.max(0, Math.floor((width - [...rawText].length) / 2));
	const styledText = parts.map((part) => part.styled).join("");
	return `${" ".repeat(leftPadding)}${styledText}`;
}

function fitLineToWidth(line: string, width: number): string {
	if (getVisibleLength(line) <= width) {
		return line;
	}

	return stripAnsi(line).slice(0, width);
}

function renderLogoLines(
	width: number,
	theme: { fg(name: string, text: string): string },
): string[] {
	return LOGO_LINES.map((line) =>
		createCenteredBlockLine(theme.fg("accent", line), width, LOGO_BLOCK_WIDTH),
	);
}

// ---- 右侧：原生默认 header 文本（对齐 pi 内置 startup header，按键文本随用户 keybindings 动态渲染） ----

function formatKeyPart(part: string): string {
	// 与 pi 内置 keybinding-hints 一致：macOS 上 alt 显示为 option
	return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

function formatKeyText(key: string): string {
	return key
		.split("/")
		.map((part) => part.split("+").map(formatKeyPart).join("+"))
		.join("/");
}

function keyText(keybinding: AppKeybinding): string {
	const keys = getKeybindings().getKeys(keybinding);
	return keys.length === 0 ? "" : formatKeyText(keys.join("/"));
}

function renderNativeLines(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): string[] {
	// 颜色方案照抄 pi 内置 header：按键 dim、描述 muted、分隔符 muted、版本 dim
	const hint = (keybinding: AppKeybinding, description: string) =>
		theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
	const rawHint = (key: string, description: string) =>
		theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);

	const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
	const compact = [
		hint("app.interrupt", "interrupt"),
		rawHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawHint("/", "commands"),
		rawHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));

	return [
		logo,
		compact,
		theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		),
		"",
		// hero 文案替换原生 "Pi can explain..." 行位置
		renderHeroParts(theme)
			.map((part) => part.styled)
			.join(""),
	];
}

function renderHeroParts(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): StyledPart[] {
	return [
		{ raw: HERO_PREFIX, styled: theme.fg("accent", HERO_PREFIX) },
		{ raw: HERO_HIGHLIGHT, styled: theme.bold(theme.fg("mdLink", HERO_HIGHLIGHT)) },
		{ raw: HERO_SUFFIX, styled: theme.fg("accent", HERO_SUFFIX) },
	];
}

export function renderHeaderLines(
	width: number,
	theme: {
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
): string[] {
	if (width < TWO_COL_MIN_WIDTH) {
		// 窄屏回退：logo + hero 单行垂直堆叠居中
		const logoLines = renderLogoLines(width, theme);
		const heroLine = createCenteredStyledLine(renderHeroParts(theme), width);
		return ["", ...logoLines, "", heroLine, ""].map((line) => fitLineToWidth(line, width));
	}

	// 双栏：左官方 logo(5 行) 右原生提示(5 行)，同高并排，gap 分隔不交叉
	const leftLines = renderLogoLines(LEFT_COLUMN_WIDTH, theme);
	const rightLines = renderNativeLines(theme);
	const rightWidth = width - LEFT_COLUMN_WIDTH - TWO_COL_GAP;
	const padTop = Math.floor((rightLines.length - leftLines.length) / 2);
	const paddedLeft = [
		...Array.from({ length: padTop }, () => ""),
		...leftLines,
		...Array.from({ length: rightLines.length - leftLines.length - padTop }, () => ""),
	];

	return paddedLeft.map(
		(line, index) =>
			`${line}${" ".repeat(TWO_COL_GAP)}${fitLineToWidth(rightLines[index] ?? "", rightWidth)}`,
	);
}

/**
 * 按配置应用启动头：on → 自定义 header；off → 恢复官方默认 header。
 * 导出供 /ccstyle 面板在切换开关时实时重应用。
 */
export function applyStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	if (!config.showStartupHeader) {
		// 恢复官方内置 header（logo + 快捷键提示 + onboarding）。
		ctx.ui.setHeader(undefined);
		return;
	}
	ctx.ui.setHeader((_tui: unknown, theme: any) => ({
		render(width: number): string[] {
			return renderHeaderLines(width, theme);
		},
		invalidate() {},
	}));
}

export default function piStartupHeader(pi: ExtensionAPI) {
	const owner = {};
	const clearHandoffTimer = () => {
		const handoff = (globalThis as any)[HEADER_HANDOFF_TIMER];
		if (handoff?.timer) clearTimeout(handoff.timer);
		delete (globalThis as any)[HEADER_HANDOFF_TIMER];
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx?.hasUI) return;
		clearHandoffTimer();
		(globalThis as any)[HEADER_OWNER] = owner;
		applyStartupHeader(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!ctx.hasUI || (globalThis as any)[HEADER_OWNER] !== owner) return;
		clearHandoffTimer();
		if (["reload", "new", "resume", "fork"].includes(event?.reason)) {
			// Keep the custom header while the replacement session is constructed.
			const handoff: { owner: object; timer?: ReturnType<typeof setTimeout> } = { owner };
			handoff.timer = setTimeout(() => {
				if ((globalThis as any)[HEADER_HANDOFF_TIMER] !== handoff) return;
				delete (globalThis as any)[HEADER_HANDOFF_TIMER];
				if ((globalThis as any)[HEADER_OWNER] !== owner) return;
				delete (globalThis as any)[HEADER_OWNER];
				ctx.ui.setHeader(undefined);
			}, HEADER_HANDOFF_TIMEOUT_MS);
			handoff.timer.unref?.();
			(globalThis as any)[HEADER_HANDOFF_TIMER] = handoff;
			return;
		}
		delete (globalThis as any)[HEADER_OWNER];
		ctx.ui.setHeader(undefined);
	});
}
