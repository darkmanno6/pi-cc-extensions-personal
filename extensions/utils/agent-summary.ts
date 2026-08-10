/**
 * Agent 回合摘要：统计一次 agent 运行的工具使用并格式化成摘要文本。
 *
 * 统计口径参考已删除的 compact-style（ea64df0 "sunset fixed-editor and compact
 * mode"）：read 按文件去重、edit/write 按文件去重、bash 计命令数、其余工具计数、
 * 失败计数、回合耗时。与旧实现一致，`read`/`edit`/`write` 只认精确的工具名
 * （MCP 风格 `server__read` 归入 other）。
 *
 * 呈现：`summaryLine` 输出纯文本（旧格式），`summaryMarkdown` 输出 Markdown
 * 增强版——加粗统计词，box 模式包 `> [!TIP]` 提示框（由 markdown-enhance 渲染
 * 成带图标的表格框），供当前 Markdown 渲染管线使用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 工具分类，与旧 compact-style 统计口径一致。 */
export type AgentToolCategory = "read" | "edit" | "bash" | "other";

/** 一次 agent 回合的统计快照。 */
export type AgentSummaryData = {
	reads: number;
	edits: number;
	commands: number;
	others: number;
	failed: number;
	durationMs: number;
};

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "read") return "read";
	if (base === "edit" || base === "write") return "edit";
	if (base === "bash") return "bash";
	return "other";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** 累积一次 agent 回合的工具统计；agent_start 时新建实例。 */
export class AgentRunSummary {
	toolCount = 0;
	readFiles = new Set<string>();
	editFiles = new Set<string>();
	commandCount = 0;
	otherCount = 0;
	failedCount = 0;

	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	/** tool_execution_start 时调用。 */
	recordToolStart(toolName: string, args?: Record<string, unknown> | null): void {
		this.toolCount++;
		const path = args?.path ?? args?.file_path;
		switch (classifyTool(toolName)) {
			case "read":
				if (nonEmptyString(path)) this.readFiles.add(path);
				break;
			case "edit":
				if (nonEmptyString(path)) this.editFiles.add(path);
				break;
			case "bash":
				this.commandCount++;
				break;
			default:
				this.otherCount++;
		}
	}

	/** tool_execution_end 时调用；isError 为 true 计入失败。 */
	recordToolResult(isError: boolean): void {
		if (isError) this.failedCount++;
	}

	snapshot(now = Date.now()): AgentSummaryData {
		return {
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			commands: this.commandCount,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: now - this.startedAt,
		};
	}
}

/** 毫秒 → "1h 2m 3s"/"2m 3s"/"3s"；低于 1 秒返回 ""（省略）。 */
export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 1) return "";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

const plural = (count: number) => (count === 1 ? "" : "s");

function summaryParts(data: AgentSummaryData): string[] {
	const parts: string[] = [];
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

/** 纯文本摘要行（旧 compact-style 格式）："Read 3 files, edited 2 files · 42s"。 */
export function summaryLine(data: AgentSummaryData): string {
	const parts = summaryParts(data);
	if (parts.length === 0) return "";
	const text = parts.join(", ");
	const capitalized = text[0].toUpperCase() + text.slice(1);
	const duration = formatDuration(data.durationMs);
	return duration ? `${capitalized} · ${duration}` : capitalized;
}

/**
 * Markdown 摘要行。
 * `box` 为 true：markdown 引用块 `> *斜体内容*`（渲染为引用，主题 mdQuote=muted 即灰色，
 * 内容斜体）。entry renderer 场景直接用。
 * `box` 为 false：整体加粗单行。
 * `colors`：成功/失败计数的 ANSI 前缀，取自主题（`theme.getFgAnsi("success")` /
 * `theme.getFgAnsi("error")`），缺省不染色。仅数字染色：成功计数的数字染
 * success 色、failed 计数的数字染 error 色，文本与时长不染色。颜色 span 以
 * `\x1b[0m` 复位，引用块渲染器会在复位后重贴引用样式，后续文本不受影响。
 */
export function summaryMarkdown(
	data: AgentSummaryData,
	box = false,
	colors: { success: string; failed: string } = { success: "", failed: "" },
): string {
	const parts = summaryParts(data);
	if (parts.length === 0) return "";
	// 仅首段动词大写（与纯文本版“句首大写”一致）
	const capitalizeFirst = (part: string, first: boolean) => {
		const verb = part.match(/^[a-z]+/)?.[0] ?? "";
		return first && verb ? verb[0].toUpperCase() + verb.slice(1) + part.slice(verb.length) : part;
	};
	// 仅染数字：`Read 2 files` → `Read <色>2</色> files`
	const paintNumber = (code: string, part: string) =>
		code ? part.replace(/(\d+)/, `${code}$1\x1b[0m`) : part;
	const text = parts
		.map((part, index) => capitalizeFirst(part, index === 0))
		.map((part) => paintNumber(part.endsWith("failed") ? colors.failed : colors.success, part))
		.join(", ");
	const duration = formatDuration(data.durationMs);
	const line = duration ? `${text} · ${duration}` : text;
	return box ? `> *${line}*` : `**${line}**`;
}

/**
 * 绑定 pi 事件到摘要统计：
 * - agent_start 重置统计
 * - tool_execution_start / tool_execution_end 累计
 * - agent_end 时回调快照（工具数 < minToolCount 不回调：单工具行本身已是摘要）
 *
 * 返回取消函数：清除当前统计引用（pi.on 不支持解绑，取消后不再产生回调）。
 */
export function bindAgentSummary(
	pi: ExtensionAPI,
	onSummary: (data: AgentSummaryData) => void,
	minToolCount = 2,
): () => void {
	let summary = new AgentRunSummary();
	pi.on("agent_start", async () => {
		summary = new AgentRunSummary();
	});
	pi.on("tool_execution_start", async (event) => {
		summary.recordToolStart(event.toolName, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		summary.recordToolResult(event.isError === true);
	});
	pi.on("agent_end", async () => {
		if (summary.toolCount >= minToolCount) onSummary(summary.snapshot());
	});
	return () => {
		summary = new AgentRunSummary();
	};
}
