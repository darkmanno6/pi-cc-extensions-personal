import type { ExpandedToolIoView, ToolIoSection } from "../tool/result.ts";

/** SGR 鼠标协议包（code;col;row + M/m 终结符）。 */
export type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

/** Final painted placement of one outermost tool/group row after parent layout. */
export type FrameToolPlacement = {
	component: any;
	componentRow: number;
	lineIndex: number;
	/** Marker-stripped final line text as painted after parent layout. */
	finalLine: string;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

/** Zero-width APC row marker (like pi CURSOR_MARKER); stripped before terminal output. */
const TOOL_FRAME_MARKER_RE = /\x1b_cc:t(\d+):(\d+)\x07/g;
const TOOL_VIEW_MARKER_RE = /\x1b_cc:v(\d+):([io])\x07/g;
export const toolFrameMarker = (id: number, row: number) => `\x1b_cc:t${id}:${row}\x07`;

/**
 * 解析整段终端输入为 SGR 鼠标包序列；数据必须完全由连续 SGR 包组成
 * （夹杂其他字节返回 null，交由常规输入链处理）。
 */
export function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
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

/** 是否为左键按下（排除修饰键、32 表示 motion 事件）。 */
export function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = packet.code & ~(4 | 8 | 16 | 32);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

/** 仅剥离终端序列、保留原布局（换行/空白不动），用于命中区间计算。 */
export function stripTerminalSequencesPreservingLayout(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** 剥离终端序列并折叠空白（用于纯文本比较）。 */
export function stripTerminalSequences(value: string): string {
	return stripTerminalSequencesPreservingLayout(value).replace(/\s+/g, " ").trim();
}

/** 工具执行组件识别（toolCallId + setExpanded + render）。 */
export function isToolExecutionComponent(value: any): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof value.toolCallId === "string" &&
			typeof value.setExpanded === "function" &&
			typeof value.render === "function",
	);
}

/** 深度收集组件树中的工具执行组件（含 getMountedRoots 分支）。 */
export function collectToolComponents(component: any, tools: any[], seen = new Set<any>()): void {
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

/** 剥离一行中的零宽帧/视图 marker。 */
export function stripToolFrameMarkers(line: string): string {
	return line.replace(TOOL_FRAME_MARKER_RE, "").replace(TOOL_VIEW_MARKER_RE, "");
}

/**
 * 从渲染行中提取工具帧 placement（component/componentRow/lineIndex/finalLine
 * 及其所属视图与 section），同时返回剥离 marker 后的行。
 */
export function extractToolFramePlacements(
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
