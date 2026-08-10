/**
 * Compact mode：每条含 toolCall 的 assistant message 折叠为一条逐步累加的摘要行
 * （`Thought for 8s, bash×2, read×2`），edit/write 独立单行（`✓ write <path> (+25 -0)`），
 * 普通工具折叠时不显示独立行；展开（Ctrl+O / fullscreen 点击）在单个工具卡中恢复
 * compact-thinking/Pi 原生或专用 renderer。edit/write 折叠时显示统计，展开时显示 rich diff。
 *
 * 统计口径与 utils/agent-summary.ts 对齐：read 按非空路径去重、bash 按调用计数、
 * 其他工具按首次出现顺序计数；edit/write 不进入摘要。思考时长复用
 * compact-thinking 的 completedDurations/activeThinking 与持久化 entry（只读查询），
 * 不建立第二套计时器。最终 agent summary 仍由 feature/agent-summary.ts 独占。
 *
 * 补丁生命周期遵循仓库既有模式：Symbol 所有权、dispose 仅恢复仍由本安装持有的
 * 方法、重入守卫防止 /reload 后残留闭包递归。
 */
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig } from "../config/config.ts";
import {
	animateCompactThinkingText,
	formatThoughtDuration,
	styleCompactThinkingText,
} from "../feature/compact-thinking.ts";
import { toolLoadingIcon } from "../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { getMessageDisplayTheme } from "./message-display.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import {
	countEditDiffStats,
	countWriteDiffStats,
	isRichDiffComponent,
} from "./tool-diff/diff-renderer.ts";
import { renderRichToolResult } from "./tool-diff/index.ts";
import type { WriteExecutionMetadataStore } from "./tool-diff/write-execution.ts";
import {
	insetComponent,
	oneLine,
	renderExpandedToolResult,
	scheduleAnimation,
} from "./tool-result.ts";

/** compact 渲染层对 compact-thinking 的只读查询面（不建第二套计时器）。 */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

const COMPACT_MODE_PATCH_KEY = Symbol.for("pi.ccstyle.compact-mode-patch");
const COMPACT_THINKING_PATCH_KEY = Symbol.for("pi.ccstyle.compact-thinking-update");
const PROTOTYPE_ORIGINAL_KEY = Symbol.for("pi.ccstyle.prototype-original");
const ASSISTANT_SET_EXPANDED_DESCRIPTION = "pi.ccstyle.compact-assistant-set-expanded";
const ASSISTANT_TOGGLE_ROUND_DESCRIPTION = "pi.ccstyle.compact-assistant-toggle-round";
const ASSISTANT_REENTRY_DESCRIPTION = "pi.ccstyle.compact-assistant-reentry";
const ASSISTANT_SET_EXPANDED_KEY = Symbol.for(ASSISTANT_SET_EXPANDED_DESCRIPTION);
const ASSISTANT_TOGGLE_ROUND_KEY = Symbol.for(ASSISTANT_TOGGLE_ROUND_DESCRIPTION);
const ASSISTANT_REENTRY_KEY = Symbol.for(ASSISTANT_REENTRY_DESCRIPTION);

const Box = (PiTui as any).Box;
const EDIT_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * 逐条 assistant message 的摘要文本（无工具计数时可为空串）：
 * 思考时长在前，工具按消息内首次出现顺序排列；read 按非空路径去重。
 */
function buildMessagesSummary(
	messages: Iterable<any>,
	query?: CompactThinkingQuery,
	thinkingActiveOverride?: boolean,
): string {
	const parts: string[] = [];
	const counts = new Map<string, number>();
	const readPaths = new Set<string>();
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let thinkingActive = false;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) thinkingActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type !== "toolCall") continue;
			const rawName = typeof item.name === "string" ? item.name : "tool";
			if (EDIT_WRITE_TOOLS.has(rawName)) continue;
			const name = sanitizeToolResultText(rawName);
			if (rawName.split(".").pop() === "read") {
				const args = item.arguments ?? item.args ?? {};
				const path = args.path ?? args.file_path ?? args.file;
				if (typeof path === "string" && path.length > 0) {
					if (readPaths.has(path)) continue;
					readPaths.add(path);
				}
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}

	thinkingActive = thinkingActiveOverride ?? thinkingActive;
	if (thinkingActive) {
		parts.push(
			durationMs > 0 ? `Thinking... · ${formatThoughtDuration(durationMs)}` : "Thinking...",
		);
	} else if (durationMs > 0) parts.push(`Thought for ${formatThoughtDuration(durationMs)}`);
	for (const [name, count] of counts) parts.push(`${name}×${count}`);
	return parts.join(", ");
}

export function buildMessageSummary(message: any, query?: CompactThinkingQuery): string {
	return buildMessagesSummary([message], query);
}

function fallbackTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
}

function themeOf(): any {
	return getMessageDisplayTheme() ?? fallbackTheme();
}

function expandedToolCard(theme: any): any {
	return new Box(
		1,
		1,
		typeof theme.bg === "function" ? (text: string) => theme.bg("userMessageBg", text) : undefined,
	);
}

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent;
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

function detachAssistantExpansion(component: any): void {
	let owned =
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY];
	if (!owned && component && typeof component === "object") {
		// 首次升级时清理旧模块使用 Symbol() 留下的实例方法。
		owned = Object.getOwnPropertySymbols(component).some(
			(symbol) =>
				symbol.description === ASSISTANT_SET_EXPANDED_DESCRIPTION && component[symbol] === true,
		);
	}
	if (!owned) return;

	delete component.setExpanded;
	for (const symbol of Object.getOwnPropertySymbols(component)) {
		if (
			symbol.description === ASSISTANT_SET_EXPANDED_DESCRIPTION ||
			symbol.description === ASSISTANT_TOGGLE_ROUND_DESCRIPTION ||
			symbol.description === ASSISTANT_REENTRY_DESCRIPTION
		) {
			delete component[symbol];
		}
	}
}

/** 供 mouse-interaction 识别可点击的 compact assistant 行（仅 compact 模式下生效）。 */
export function isCompactAssistantComponent(value: unknown): boolean {
	if (config.mode !== "compact" || !value || typeof value !== "object") return false;
	const component = value as any;
	return (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	);
}

export type CompactModeHooks = {
	/** 会话事件后同步：所有权、全局展开状态、已挂载组件。 */
	sync(ctx: any): void;
	/** 重绘所有被跟踪的 assistant/tool 组件（模式切换用）。 */
	refresh(): void;
	/** compact 模式下重新认领 assistant patch（位于 compact-thinking 之上）。 */
	assertOwnership(): void;
	/** 重新渲染包含指定 toolCallId 的 assistant 消息（思考收尾时刷新时长）。 */
	refreshToolCallMessage(toolCallId: string | undefined): void;
	shutdown(): void;
};

type CompactModeInstallDeps = {
	query?: CompactThinkingQuery;
	writeMetadata: WriteExecutionMetadataStore;
};

type CompactModePatch = {
	active: boolean;
	prototype: any;
	assistantInstalled: (...args: any[]) => any;
	assistantOriginal: (...args: any[]) => any;
	assistantNative: (...args: any[]) => any;
	toolInstalledRender: (width: number) => string[];
	toolInstalledUpdateDisplay: () => void;
	toolOriginalRender: (width: number) => string[];
	toolOriginalUpdateDisplay: () => void;
	assertAssistantOwnership: () => void;
	dispose: () => void;
};

const trackedAssistantComponents = new Set<any>();
const trackedToolComponents = new Set<any>();
let hoveredAssistantComponent: any;

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

function compactEditWriteLine(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const path = sanitizeToolResultText(
		typeof args.path === "string" && args.path
			? args.path
			: typeof args.file_path === "string" && args.file_path
				? args.file_path
				: "",
	);
	const isError = component.result?.isError === true;
	const isPending = !component.result || component.isPartial === true;
	const icon = isError ? "✗" : isPending ? toolLoadingIcon() : "✓";
	const iconColor = isError ? "error" : isPending ? "accent" : "success";
	let statsText = "";
	let statsStyled = "";
	if (!isError && !isPending) {
		const stats =
			name === "edit"
				? countEditDiffStats(component.result?.details)
				: name === "write"
					? countWriteDiffStats(
							typeof args.content === "string" ? args.content : undefined,
							writeMetadata?.get(component.toolCallId)?.previousContent,
							writeMetadata?.get(component.toolCallId)?.fileExistedBeforeWrite,
						)
					: undefined;
		if (stats) {
			statsText = ` (+${stats.added} -${stats.removed})`;
			statsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
		}
	}
	const iconPart = ` ${theme.fg(iconColor, icon)} `;
	const namePart = theme.fg("toolTitle", name);
	const hintText = component.expanded ? "" : ` • ${showMoreHintText()}`;
	const fixedWidth =
		visibleWidth(iconPart) +
		visibleWidth(namePart) +
		visibleWidth(statsText) +
		visibleWidth(hintText);
	const pathWidth = Math.max(0, width - fixedWidth - (path ? 1 : 0));
	const pathPart = pathWidth > 0 && path ? ` ${oneLine(path, pathWidth)}` : "";
	const line = `${iconPart}${namePart}${theme.fg("toolTitle", pathPart)}${statsStyled}${hintText ? theme.fg("dim", hintText) : ""}`;
	return ["", truncateToWidth(line, width, "")];
}

/** compact edit/write 展开：复用 mode=on 的 rich diff；不可用时回退 Input/Output。 */
function compactEditWriteExpandedLines(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const result = component.result;
	const isError = result?.isError === true;
	const candidate = writeMetadata
		? renderRichToolResult(
				String(component.toolName ?? ""),
				result,
				{
					expanded: true,
					isPartial: component.isPartial === true,
					isError,
				},
				theme,
				component,
				writeMetadata,
				getToolDisplayConfig,
			)
		: undefined;
	let detail: any;
	if (isRichDiffComponent(candidate)) {
		component.resultRendererComponent = candidate;
		detail = insetComponent(candidate as any);
	} else {
		const outputText = sanitizeToolResultText(
			Array.isArray(result?.content)
				? result.content
						.filter((item: any) => item?.type === "text")
						.map((item: any) => String(item.text ?? ""))
						.join("\n")
				: "",
		);
		const state = (component.state ??= {});
		detail = renderExpandedToolResult(
			outputText,
			theme,
			isError,
			state.ccstyleIoView,
			component.args,
			component,
		);
		component.resultRendererComponent = detail;
	}

	const box = expandedToolCard(theme);
	box.addChild({
		render(innerWidth: number): string[] {
			return compactEditWriteLine(component, innerWidth, writeMetadata).slice(1);
		},
		invalidate() {},
	});
	box.addChild(detail);
	return box.render(width);
}

function compactAssistantLineComponent(
	component: any,
	summary: string,
	query?: CompactThinkingQuery,
	options: { hint?: boolean; leadingBlank?: boolean; pad?: number } = {},
): any {
	const self = component as any;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hintText = options.hint === false ? "" : ` • ${showMoreHintText()}`;
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const thinkingActive = summary.startsWith("Thinking...");
			const displaySummary = thinkingActive
				? `${self.hiddenThinkingLabel || "Thinking..."}${summary.slice("Thinking...".length)}`
				: summary;
			const plainText = truncateToWidth(displaySummary, summaryWidth, "…");
			let text = theme.fg("muted", plainText);
			if (thinkingActive || plainText.startsWith("Thought for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (thinkingActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(
						label,
						theme,
						query?.getThinkingAnimationFrame?.() ?? 0,
					)}${styleCompactThinkingText(duration, theme)}${theme.fg("muted", tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${theme.fg("muted", tools)}`;
				}
			}
			const hintColor = hoveredAssistantComponent === component ? "text" : "dim";
			const line = `${text}${hintText ? theme.fg(hintColor, hintText) : ""}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			return options.leadingBlank === false ? [rendered] : ["", rendered];
		},
		invalidate() {},
	};
}

function compactAssistantLine(component: any, summary: string, query?: CompactThinkingQuery): void {
	if (!summary) return;
	component.contentContainer.addChild(compactAssistantLineComponent(component, summary, query));
}

function ensureAssistantSetExpanded(component: any): void {
	if (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	if (typeof component.setExpanded === "function") {
		detachAssistantExpansion(component);
		if (typeof component.setExpanded === "function") return;
	}
	const installed = function (this: any, expanded: boolean) {
		if (config.mode !== "compact") {
			detachAssistantExpansion(this);
			return;
		}
		const toggleRound = this[ASSISTANT_TOGGLE_ROUND_KEY];
		if (typeof toggleRound === "function") {
			toggleRound(expanded);
			return;
		}
		this.expanded = expanded;
		if (typeof this.updateContent === "function" && this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	};
	component[ASSISTANT_SET_EXPANDED_KEY] = installed;
	component.setExpanded = installed;
}

function collectMountedComponents(root: any): void {
	if (!root || typeof root !== "object") return;
	const seen = new Set<any>();
	const assistants = new Set<any>();
	const tools = new Set<any>();
	const visit = (value: any): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		if (isAssistantComponent(value)) {
			assistants.add(value);
			// 仅在 compact 模式给实例装 setExpanded，避免 on/off 下 Ctrl+O/mouse 回归。
			if (config.mode === "compact") ensureAssistantSetExpanded(value);
		} else if (isToolComponent(value)) {
			tools.add(value);
		}
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
		try {
			const mounted = value.getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const root2 of mounted) visit(root2);
			}
		} catch {
			// renderer 切换中的惰性 Proxy 可能暂时没有 mounted roots
		}
	};
	visit(root);
	trackedAssistantComponents.clear();
	trackedToolComponents.clear();
	for (const component of assistants) trackedAssistantComponents.add(component);
	for (const component of tools) trackedToolComponents.add(component);
}

export function installCompactMode(deps: CompactModeInstallDeps): CompactModeHooks {
	const host = globalThis as any;
	const previous = host[COMPACT_MODE_PATCH_KEY] as CompactModePatch | undefined;
	if (previous) previous.dispose();

	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const patch: CompactModePatch = {
		active: true,
		prototype: assistantPrototype,
		assistantInstalled: undefined as any,
		assistantOriginal: assistantPrototype.updateContent,
		assistantNative: assistantPrototype.updateContent,
		toolInstalledRender: undefined as any,
		toolInstalledUpdateDisplay: undefined as any,
		toolOriginalRender: toolPrototype.render,
		toolOriginalUpdateDisplay: toolPrototype.updateDisplay,
		assertAssistantOwnership: () => {},
		dispose: () => {},
	};

	const passThroughAssistant = (component: any, message: any): any => {
		const self = component as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch)
			return patch.assistantNative.call(component, message);
		self[ASSISTANT_REENTRY_KEY] = patch;
		try {
			return patch.assistantOriginal.call(component, message);
		} finally {
			delete self[ASSISTANT_REENTRY_KEY];
		}
	};

	type CompactRound = {
		anchor: any;
		messages: Map<any, any>;
		detachedMessages: any[];
		active: boolean;
		suppressedToolIds: Set<string>;
	};
	let activeRound: CompactRound | undefined;
	let roundByComponent = new WeakMap<object, CompactRound>();
	const expandedRoundToolIds = new Set<string>();

	const renderAssistantWithoutThinking = (component: any, message: any): any => {
		const content = Array.isArray(message?.content) ? message.content : [];
		const result = passThroughAssistant(component, {
			...message,
			content: content.filter((item: any) => item?.type !== "thinking"),
		});
		component.lastMessage = message;
		return result;
	};

	const roundMessages = (round: CompactRound): any[] => [
		...round.messages.values(),
		...round.detachedMessages,
	];

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	const renderRound = (round: CompactRound): void => {
		const summary = buildMessagesSummary(roundMessages(round), deps.query, round.active);
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();

		for (const [component, message] of round.messages) {
			component.lastMessage = message;
			ensureAssistantSetExpanded(component);
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
			};
		}

		if (round.anchor.expanded === true) {
			const assistantChildren: any[] = [];
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, message);
				if (Array.isArray(component.contentContainer?.children)) {
					assistantChildren.push(...component.contentContainer.children);
				}
				component.contentContainer?.clear?.();
			}
			const ids = roundToolCallIds(round);
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
			}
			// Round 展开只打开外层卡片。普通工具保持折叠，避免长输出递归撑满屏幕。
			for (const tool of trackedToolComponents) {
				if (
					!ids.has(tool.toolCallId) ||
					EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")) ||
					tool.expanded !== true
				) {
					continue;
				}
				if (typeof tool.setExpanded === "function") tool.setExpanded(false);
				else {
					tool.expanded = false;
					tool.updateDisplay?.();
				}
			}
			round.anchor.contentContainer.addChild({
				render(width: number): string[] {
					const theme = themeOf();
					const box = expandedToolCard(theme);
					box.addChild(
						compactAssistantLineComponent(round.anchor, summary, deps.query, {
							hint: false,
							leadingBlank: false,
							pad: 0,
						}),
					);
					for (const child of assistantChildren) box.addChild(child);
					const ids = roundToolCallIds(round);
					for (const tool of trackedToolComponents) {
						if (!ids.has(tool.toolCallId) || EDIT_WRITE_TOOLS.has(String(tool.toolName ?? ""))) {
							continue;
						}
						box.addChild({
							render: (innerWidth: number) => patch.toolOriginalRender.call(tool, innerWidth),
							invalidate: () => tool.invalidate?.(),
						});
					}
					return ["", ...box.render(width)];
				},
				invalidate() {
					for (const child of assistantChildren) child.invalidate?.();
				},
			});
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				renderAssistantWithoutThinking(component, message);
				compactAssistantLine(component, summary, deps.query);
			} else {
				component.contentContainer?.clear?.();
			}
		}
	};

	const activateRound = (round: CompactRound): void => {
		round.active = true;
		activeRound = round;
		deps.query?.setCompactSummaryActive?.(true);
	};

	const finishRound = (round: CompactRound): void => {
		round.active = false;
		renderRound(round);
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
		}
	};

	const resetRounds = (): void => {
		activeRound = undefined;
		roundByComponent = new WeakMap();
		expandedRoundToolIds.clear();
		deps.query?.setCompactSummaryActive?.(false);
	};

	patch.assistantInstalled = function (this: any, message: any) {
		const self = this as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.assistantNative.call(this, message);
		}
		self.lastMessage = message;
		trackedAssistantComponents.add(this);
		if (!patch.active || config.mode !== "compact") {
			return passThroughAssistant(this, message);
		}
		if (!self.contentContainer || typeof self.contentContainer.clear !== "function") {
			return passThroughAssistant(this, message);
		}

		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls) {
			let round = roundByComponent.get(this);
			if (hasText && (!round || round.anchor !== this)) {
				if (round) round.messages.delete(this);
				if (activeRound) finishRound(activeRound);
				round = {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
				};
				roundByComponent.set(this, round);
				activateRound(round);
			} else if (!round) {
				round = activeRound ?? {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
				};
				roundByComponent.set(this, round);
				if (!activeRound) activateRound(round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			const previousMessage = round?.messages.get(this);
			if (round && previousMessage && (round.anchor !== this || round.messages.size > 1)) {
				// 最终回答开始后，当前组件恢复原生文本；它已完成的 thinking
				// 留在上一轮摘要中，避免再次生成独立 Thought 行。
				round.messages.delete(this);
				round.detachedMessages.push(previousMessage);
				roundByComponent.delete(this);
				finishRound(round);
				return renderAssistantWithoutThinking(this, message);
			}
			if (round) {
				round.active = false;
				roundByComponent.delete(this);
				if (activeRound === round) {
					activeRound = undefined;
					deps.query?.setCompactSummaryActive?.(false);
				}
				return passThroughAssistant(this, message);
			}
			if (activeRound) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = activeRound ?? {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
				};
				roundByComponent.set(this, round);
				if (!activeRound) activateRound(round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		self.contentContainer.clear();
		return undefined;
	};

	patch.toolInstalledRender = function (this: any, width: number) {
		if (!patch.active || config.mode !== "compact") {
			return patch.toolOriginalRender.call(this, width);
		}
		const name = String(this.toolName ?? "");
		if (EDIT_WRITE_TOOLS.has(name)) {
			if (!this.result || this.isPartial === true) scheduleAnimation(this);
			const lines = compactEditWriteLine(this, width, deps.writeMetadata);
			if (this.expanded !== true) return lines;
			return compactEditWriteExpandedLines(this, width, deps.writeMetadata);
		}
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		if (
			patch.active &&
			config.mode === "compact" &&
			expandedRoundToolIds.has(String(this.toolCallId ?? ""))
		) {
			this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		trackedToolComponents.add(this);
		return result;
	};

	patch.assertAssistantOwnership = () => {
		// 仅从已标记的 compact-thinking 包装器重新认领。未知外部包装器必须保留所有权。
		if (!patch.active || assistantPrototype.updateContent === patch.assistantInstalled) return;
		const current = assistantPrototype.updateContent;
		if ((current as any)[COMPACT_THINKING_PATCH_KEY] !== true) return;
		patch.assistantOriginal = current;
		assistantPrototype.updateContent = patch.assistantInstalled;
	};

	(patch.assistantInstalled as any)[PROTOTYPE_ORIGINAL_KEY] = patch.assistantNative;

	patch.dispose = () => {
		if (!patch.active) return;
		patch.active = false;
		if (assistantPrototype.updateContent === patch.assistantInstalled) {
			assistantPrototype.updateContent = patch.assistantOriginal;
		}
		if (toolPrototype.render === patch.toolInstalledRender) {
			toolPrototype.render = patch.toolOriginalRender;
		}
		if (toolPrototype.updateDisplay === patch.toolInstalledUpdateDisplay) {
			toolPrototype.updateDisplay = patch.toolOriginalUpdateDisplay;
		}
		if (host[COMPACT_MODE_PATCH_KEY] === patch) delete host[COMPACT_MODE_PATCH_KEY];
		for (const component of trackedAssistantComponents) detachAssistantExpansion(component);
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		resetRounds();
	};

	assistantPrototype.updateContent = patch.assistantInstalled;
	toolPrototype.render = patch.toolInstalledRender;
	toolPrototype.updateDisplay = patch.toolInstalledUpdateDisplay;
	host[COMPACT_MODE_PATCH_KEY] = patch;

	const syncGlobalExpanded = (ctx: any): void => {
		let globalExpanded = false;
		try {
			globalExpanded = ctx?.ui?.getToolsExpanded?.() === true;
		} catch {
			// 测试或无 UI 上下文时保持折叠。
		}
		for (const component of trackedAssistantComponents) component.expanded = globalExpanded;
		for (const component of trackedToolComponents) component.expanded = globalExpanded;
	};

	const releaseAssistantOwnership = (): void => {
		if (assistantPrototype.updateContent === patch.assistantInstalled) {
			assistantPrototype.updateContent = patch.assistantOriginal;
		}
	};

	return {
		sync(ctx: any) {
			if (!patch.active) return;
			resetRounds();
			if (config.mode === "compact") {
				patch.assertAssistantOwnership();
				syncGlobalExpanded(ctx);
			} else {
				releaseAssistantOwnership();
			}
			refreshTrackedComponents();
		},
		refresh() {
			if (!patch.active) return;
			resetRounds();
			if (config.mode !== "compact") {
				releaseAssistantOwnership();
				hoveredAssistantComponent = undefined;
			}
			refreshTrackedComponents();
		},
		assertOwnership() {
			if (!patch.active) return;
			patch.assertAssistantOwnership();
		},
		refreshToolCallMessage(toolCallId: string | undefined) {
			if (!patch.active || typeof toolCallId !== "string" || !toolCallId) return;
			for (const component of [...trackedAssistantComponents]) {
				const message = component.lastMessage;
				const contains =
					Array.isArray(message?.content) &&
					message.content.some((item: any) => item?.type === "toolCall" && item.id === toolCallId);
				if (!contains) continue;
				try {
					component.updateContent?.(message);
				} catch {
					trackedAssistantComponents.delete(component);
				}
			}
		},
		shutdown() {
			patch.dispose();
		},
	};
}

function refreshTrackedComponents(): void {
	for (const component of [...trackedAssistantComponents]) {
		try {
			if (config.mode !== "compact") detachAssistantExpansion(component);
			if (component.lastMessage) component.updateContent?.(component.lastMessage);
			else component.invalidate?.();
		} catch {
			trackedAssistantComponents.delete(component);
		}
	}
	for (const component of [...trackedToolComponents]) {
		try {
			component.updateDisplay?.();
			component.invalidate?.();
		} catch {
			trackedToolComponents.delete(component);
		}
	}
}

/** 供 renderer/index.ts 在 session 事件后收集 /reload 重建的组件。 */
export function refreshCompactModeComponents(root: any): void {
	collectMountedComponents(root);
}
