import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { installToolGrouping, type ToolGroupingHooks } from "./tool-grouping.ts";
import {
	installCompactMode,
	refreshCompactModeComponents,
	type CompactModeHooks,
} from "./compact-mode.ts";
import { isLazyProxyTui } from "../utils/fullscreen-detect.ts";
import { showCcstylePanel } from "../config/panel.ts";
import {
	config,
	DEFAULT_CONFIG,
	formatConfigStatus,
	getCompactThinkingConfig,
	getToolDisplayConfig,
	normalizeConfig,
	saveConfig,
	setConfig,
	type CompactStyleMode,
	type Config,
} from "../config/config.ts";
import {
	installToolMouseInteraction,
	isToolCallHovered,
	resetToolHoverState,
	scheduleSessionRender,
	setHoveredToolGroup,
	setHoveredToolIo,
	teardownToolMouseInteraction,
	toolMouseTui,
	TOOL_MOUSE_DISABLE,
} from "./mouse-interaction.ts";
import {
	clearAllAnimations,
	countLines,
	hasExpandableDetail,
	headTruncateToWidth,
	insetComponent,
	isToolExpanded,
	middleTruncateToWidth,
	oneLine,
	outputLineCount,
	pendingIcon,
	renderCollapsedToolResultToWidth,
	renderExpandedToolResult,
	resolveToolVisualState,
	scheduleAnimation,
	settledIcon,
	setToolVisualState,
	textFromResult,
	toolIconColor,
	toolViewportWidth,
} from "./tool-result.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import type { CompactThinkingQuery } from "./compact-mode.ts";
import {
	installWriteOverride,
	renderRichToolResult,
	WriteExecutionMetadataStore,
} from "./tool-diff/index.ts";
import {
	getMessageDisplayTheme,
	installMessageDisplayRendering,
	refreshMessageDisplays,
	setMessageDisplayTheme,
} from "./message-display.ts";

/**
 * Claude Code Style for pi — 装配入口（拆分后位于 ccstyle/index.ts）。
 *
 * Tool rendering (summaries, rich edit/write diffs, expand/collapse) is applied
 * via prototype-level patches.
 */
// Bright green for success icon (truecolor ANSI escape)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_FG_RESET = "\x1b[39m";

function refreshCurrentTranscript(ctx?: any, toolGrouping?: ToolGroupingHooks): void {
	toolGrouping?.refresh(toolMouseTui);
	refreshMessageDisplays(toolMouseTui);
	refreshCompactModeComponents(toolMouseTui);
	compactModeHooks?.refresh();
	toolMouseTui?.requestRender?.(true);
	ctx?.ui?.requestRender?.(true);
}

let compactModeHooks: CompactModeHooks | undefined;

function syncCompactMode(ctx: any): void {
	refreshCompactModeComponents(toolMouseTui);
	compactModeHooks?.sync(ctx);
}

function applyStyleMode(mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks): void {
	config.mode = mode;
	saveConfig();
	if (mode === "off") {
		// Native rendering mode: drop hover/click state and fully disable mouse
		// reporting so the terminal restores its default scrollback wheel scrolling.
		resetToolHoverState();
		setHoveredToolGroup(null);
		setHoveredToolIo(null, null);
		// 惰性 Proxy（regular/fullscreen）不持有 reporting：regular 保终端回滚，
		// fullscreen 归官方所有，均不能在此关闭。
		if (toolMouseTui && !isLazyProxyTui(toolMouseTui)) {
			toolMouseTui.terminal?.write?.(TOOL_MOUSE_DISABLE);
		}
	} else if (mode === "compact") {
		// 切入 compact：先收集当前 transcript，再同步全局展开状态和补丁所有权。
		syncCompactMode(ctx);
	}
	refreshCurrentTranscript(ctx, toolGrouping);
	ctx.ui.notify(`Claude Code style: ${mode}`, "info");
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

function singleLine(text: string) {
	return {
		render: (width: number) => [truncateToWidth(text, width, "…")],
		invalidate() {},
	};
}

function humanizeToolLabel(label: string): string {
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function singleToolCallSummary(
	toolName: string,
	label: string,
	args: any,
): { main: string; detail: string } {
	const title = label === toolName ? humanizeToolLabel(label) : label;
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();
	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		// 与多 tool 摘要对齐：从头截断，上限 96 字符（tool-grouping oneLine 默认值）。
		return `${title} ${oneLine(found || fallback, 96)}`;
	};
	if (AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${oneLine(args.agent_id, 96)}`, detail: "" };
	}
	// Agents still uses the ccstyle wrapper; Agent keeps its dedicated renderer.
	if (name === "agents") {
		return {
			main: value("launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		return {
			main: `${title}${args.path ? ` ${oneLine(args.path, 96)}` : ""}`,
			detail: details.length ? ` (${details.join(", ")})` : "",
		};
	}
	const preferred =
		args.path ??
		args.file_path ??
		args.command ??
		args.query ??
		args.question ??
		args.pattern ??
		args.url ??
		args.name ??
		args.tool_use_id ??
		args.toolCallId ??
		args.id ??
		args.message;
	return {
		main:
			preferred !== undefined && preferred !== null && typeof preferred !== "object"
				? `${title} ${oneLine(preferred, 96)}`
				: title,
		detail: "",
	};
}

export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" • ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `   ${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `   … ${tasks.length - rows.length} more tasks`));
		return new Text(` ↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.join("\n")}`, 0, 0);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	let match: RegExpMatchArray | null;
	if (
		toolName === "TaskCreate" &&
		(match = line.match(/^Task #(\d+) created successfully: (.+)$/))
	) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(` ↳ ${formatted}`, 0, 0) : undefined;
}

/** Wrap an arbitrary tool definition with ccstyle call/result rendering. */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? humanizeMcpToolName(toolName)
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
					? `${BRIGHT_GREEN}${rawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), rawIcon);
			const summary = singleToolCallSummary(toolName, label, args);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine !== undefined && cachedWidth === width) return [cachedLine];
					const viewportWidth = toolViewportWidth(width);
					const callWidth = Math.max(0, viewportWidth - visibleWidth(icon) - 2);
					const mainWidth = Math.max(0, callWidth - visibleWidth(summary.detail));
					cachedWidth = width;
					// 纯文本先截断再着色（省略号不带 ANSI，避免 reset 破坏卡片背景）；从头截断，与多 tool 一致
					cachedLine = ` ${icon} ${theme.fg("toolTitle", headTruncateToWidth(summary.main, mainWidth))}${theme.fg("dim", summary.detail)}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {},
			};
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
				return new Text(theme.fg("muted", "   ↳ Pending…"), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const expanded = isToolExpanded(options, context);
			const toolCallId = context?.toolCallId;
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// Pass getter so Diff indicator / wrap / limits update on the next paint
				// without recreating the tool result component.
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
						// 全局共享状态避免 /reload 后旧 result renderer 闭包失联。
						isHovered: () => isToolCallHovered(toolCallId),
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				if (richResult) return insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const outputLines = outputLineCount(result) || countLines(text);
			const lineWord = outputLines === 1 ? "line" : "lines";
			const action = toolName === "read" ? "loaded" : "returned";
			const rendered = tasks.length
				? taskListSummary(tasks)
				: isError
					? text
						? oneLine(text)
						: "Failed"
					: outputLines
						? `${outputLines} ${lineWord} ${action}`
						: "Done";
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hintText = showMoreHintText();
			const hintPrefix = expandable ? theme.fg("dim", " • ") : "";
			const hint = expandable ? hintPrefix + theme.fg("dim", hintText) : "";
			const hoveredHint = expandable ? hintPrefix + theme.fg("text", hintText) : "";
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
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedHoveredLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hint, width),
						);
						cachedHoveredLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hoveredHint, width),
						);
					}
					return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
				},
				invalidate() {},
			};
		},
	};
}

/**
 * Apart from the write override used to capture pre-write content, renderers are
 * applied through ToolExecutionComponent. Patch its lookup once so tools use the
 * same ccstyle fallback shell by default. Tools named in excludeRenderers keep
 * their original renderer.
 */
const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
const COMPONENT_TOOL_SELF_SHELL_MODE = Symbol.for("pi.ccstyle.component-tool-self-shell-mode");
const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);
// pi-subagents 等扩展为 Agent 提供专用渲染器（displayName/运行统计），ccstyle 必须保留，不能 wrap。
const DEDICATED_RENDERER_TOOLS = new Set(["Agent"]);

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

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

export function humanizeMcpToolName(toolName: string): string {
	const words = toolName
		.replace(/^mcp(?:[_:-]+)+/i, "")
		.split(/[_:-]+/)
		.filter(Boolean);
	return words.length
		? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")
		: "MCP";
}

/** Return true when this tool must keep its original renderer. */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
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
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function shouldUseSelfShell(component: any, _patch: GlobalToolRenderPatch): boolean {
	component[COMPONENT_TOOL_SELF_SHELL_MODE] = false;
	return false;
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
			const useSelfShell = shouldUseSelfShell(this, patch);
			const useCcstyle = shouldGloballyStyleTool(this, patch);
			const shell =
				useSelfShell || (useCcstyle && !this.expanded)
					? "self"
					: useCcstyle
						? "default"
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

const TOOL_EXPANDED_BACKGROUND_PATCH = Symbol.for("pi.ccstyle.tool-expanded-background-patch");

type ToolExpandedBackgroundPatch = {
	active: boolean;
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
	dispose: () => void;
};

/** 展开面板背景统一为 user message 背景色；折叠行保持原生状态色（由 original 重设）。 */
function installToolExpandedBackground(): () => void {
	const host = globalThis as any;
	const previous = host[TOOL_EXPANDED_BACKGROUND_PATCH] as ToolExpandedBackgroundPatch | undefined;
	if (previous) previous.dispose();
	const prototype = ToolExecutionComponent.prototype;
	const original = prototype.updateDisplay;
	const patch: ToolExpandedBackgroundPatch = {
		active: true,
		prototype,
		installed: function (this: any) {
			original.call(this);
			if (!patch.active || config.mode !== "on" || !this.expanded) return;
			const theme = getMessageDisplayTheme();
			if (!theme?.bg) return;
			const box = this.contentBox;
			if (box?.setBgFn) box.setBgFn((text: string) => theme.bg("userMessageBg", text));
		},
		original,
		dispose: () => {
			patch.active = false;
			if (prototype.updateDisplay === patch.installed) {
				prototype.updateDisplay = original;
			}
			if (host[TOOL_EXPANDED_BACKGROUND_PATCH] === patch) {
				delete host[TOOL_EXPANDED_BACKGROUND_PATCH];
			}
		},
	};
	prototype.updateDisplay = patch.installed;
	host[TOOL_EXPANDED_BACKGROUND_PATCH] = patch;
	return patch.dispose;
}

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

export default function (
	pi: ExtensionAPI,
	configOverride?: Partial<Config>,
	compactThinking?: CompactThinkingController,
) {
	// The optional override keeps integration tests independent from the user's global config.
	if (configOverride) setConfig(normalizeConfig({ ...config, ...configOverride }));
	const writeExecutionMetadata = new WriteExecutionMetadataStore();
	const mouseOwner = {};
	let installation:
		| {
				globalToolRendering: GlobalToolRenderPatch;
				toolGrouping: ToolGroupingHooks;
				compactMode: CompactModeHooks;
				disposeMessageDisplay: () => void;
				disposeToolExpandedBackground: () => void;
		  }
		| undefined;
	const ensureTuiInstallation = (ctx: any) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return undefined;
		// 渲染层（工具样式/分组）是原型与组件级 patch，fullscreen 官方布局
		// 同样渲染这些组件，因此两种模式都安装。
		if (installation) return installation;
		const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
		const toolGrouping = installToolGrouping(() => config.mode === "on");
		const compactMode = installCompactMode({
			query: compactThinking as CompactThinkingQuery | undefined,
			writeMetadata: writeExecutionMetadata,
		});
		compactModeHooks = compactMode;
		const disposeMessageDisplay = installMessageDisplayRendering();
		const disposeToolExpandedBackground = installToolExpandedBackground();
		deactivateLegacyCompactionRendering();
		installation = {
			globalToolRendering,
			toolGrouping,
			compactMode,
			disposeMessageDisplay,
			disposeToolExpandedBackground,
		};
		return installation;
	};

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style and rich diff options",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{
					value: "compact",
					label: "compact",
					description: "One summary line per assistant message",
				},
				{ value: "off", label: "off", description: "Use Pi's native renderer" },
				{ value: "status", label: "status", description: "Show full configuration" },
				{ value: "panel", label: "panel", description: "Open interactive settings panel" },
			];
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === "panel" || arg === "on" || arg === "compact" || arg === "off") {
				if (ctx?.mode !== "tui" || !ctx?.hasUI) {
					ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
					return;
				}
				const hooks = ensureTuiInstallation(ctx);
				if (!hooks) return;
				if (!arg || arg === "panel") {
					await showCcstylePanel(
						ctx,
						{ applyStyleMode, refreshCurrentTranscript },
						hooks.toolGrouping,
						compactThinking,
					);
				} else {
					applyStyleMode(arg, ctx, hooks.toolGrouping);
				}
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Claude Code style: ${formatConfigStatus(config)}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|compact|off|status|panel]", "warning");
		},
	});

	pi.on("message_update", async (event) => {
		// compact-thinking 在 session_start 时于 compact 补丁之上再装一层；
		// 扩展事件先于 interactive-mode 的 updateContent 派发，此处先重新认领。
		if (config.mode === "compact" && event.message?.role === "assistant") {
			compactModeHooks?.assertOwnership();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (config.mode !== "compact") return;
		// Agent 工具在 tool_execution_end 收尾思考：延迟到所有监听器之后刷新，
		// 让 compact-thinking 先写入最终时长，再重绘摘要行。
		const toolCallId: string | undefined = event?.toolCallId;
		setTimeout(() => {
			compactModeHooks?.refreshToolCallMessage(toolCallId);
		}, 0);
	});

	pi.on("session_start", async (event, ctx) => {
		// 延迟到 session_start 注册 write override：加载阶段 getAllTools 不可用且其他扩展
		// 尚未注册工具，无法检测外部 write 所有者（如 pi-spark），直接注册会与对方撞名。
		// session_start 时所有扩展已加载完毕，installWriteOverride 内部会检测并让位。
		installWriteOverride(pi, writeExecutionMetadata);
		const hooks = ensureTuiInstallation(ctx);
		// 鼠标交互独立于渲染层：fullscreen 渲染层让位（hooks undefined）但
		// 工具点击/回到底部适配仍需安装；保持在渲染层安装之后以维持原顺序。
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		ctx.ui.setStatus("ccstyle", undefined);
		// 先收集 resume transcript，再同步 compact 补丁与全局展开状态。
		syncCompactMode(ctx);
		// compact-thinking 的 session_start 处理在本 handler 之后执行（在其之上再装
		// 一层 updateContent）；延迟再同步一次，保证 compact 补丁最终位于外层。
		setTimeout(() => syncCompactMode(ctx), 0);
		scheduleSessionRender(() => hooks.toolGrouping.refresh(toolMouseTui));
	});

	pi.on("session_compact", async (event, ctx) => {
		const hooks = ensureTuiInstallation(ctx);
		// Compaction rebuilds the transcript without session_start. Rebind after
		// other TUI extensions may have replaced the root input dispatcher.
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		syncCompactMode(ctx);
		scheduleSessionRender(() => {
			syncCompactMode(ctx);
			hooks.toolGrouping.refresh(toolMouseTui);
		});
	});

	pi.on("session_tree", async (event, ctx) => {
		// 会话树重建后在当前帧和下一帧各同步一次，替换旧组件引用。
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		syncCompactMode(ctx);
		scheduleSessionRender(() => syncCompactMode(ctx));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		installation?.toolGrouping.setTheme(ctx.ui.theme);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		writeExecutionMetadata.clear();
		// 鼠标交互独立于渲染层：fullscreen 下 installation 为 undefined，
		// 但 onTerminalInput 监听与 handleViewportInput 包装仍需释放。
		teardownToolMouseInteraction(mouseOwner);
		const current = installation;
		if (
			!current ||
			(globalThis as any)[GLOBAL_TOOL_RENDER_PATCH] !== current.globalToolRendering ||
			!current.globalToolRendering.active
		)
			return;
		deactivateGlobalToolRendering(current.globalToolRendering);
		current.toolGrouping.shutdown();
		current.disposeToolExpandedBackground();
		current.compactMode.shutdown();
		compactModeHooks = undefined;
		current.disposeMessageDisplay();
		deactivateLegacyCompactionRendering();
		clearAllAnimations();
		installation = undefined;
	});
}

// ---- 对外导出：保持与拆分前 claude-code-style.ts 完全一致的符号集合 ----
export {
	DEFAULT_CONFIG,
	formatConfigStatus,
	getCompactThinkingConfig,
	getToolDisplayConfig,
	normalizeConfig,
} from "../config/config.ts";
export type { CompactStyleMode, Config } from "../config/config.ts";
export {
	ExpandedToolIoView,
	ExpandedToolResultText,
	formatExpandHint,
	formatToolInputArgs,
	headTruncateToWidth,
	middleTruncateToWidth,
	outputLineCount,
	renderCollapsedToolResult,
	renderCollapsedToolResultToWidth,
	SHOW_MORE_LABEL,
} from "./tool-result.ts";
export type { ToolIoSection } from "./tool-result.ts";
export { installToolMouseInteraction } from "./mouse-interaction.ts";
