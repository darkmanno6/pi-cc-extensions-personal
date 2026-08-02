import { CustomMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("pi.ccstyle.subagent-notification-patch");
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

type Patch = {
	active: boolean;
	prototype: any;
	originalRender: (width: number) => string[];
	installedRender: (width: number) => string[];
};

function plain(line: string): string {
	return line.replace(ANSI_RE, "");
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && !plain(lines[start]!).trim()) start++;
	while (end > start && !plain(lines[end - 1]!).trim()) end--;
	return lines.slice(start, end);
}

function normalizeStatusGlyph(line: string): string {
	return line.replace(
		/^((?:\x1b\[[0-?]*[ -/]*[@-~]|[ \t]|[├└│─])*)[✓✔]((?:\x1b\[[0-?]*[ -/]*[@-~])*)(?=\s)/,
		"$1●$2",
	);
}

function isHeader(line: string): boolean {
	return /^[✓✔✗■●]\s+/.test(plain(line).trimStart());
}

function isDetail(line: string): boolean {
	const text = plain(line).trimStart();
	return (
		text.startsWith("⎿") ||
		text.startsWith("transcript:") ||
		text === "No output." ||
		/^(?:Done|Wrapped up|Stopped|Error:|Aborted)\b/.test(text)
	);
}

function cleanDetail(line: string): string {
	const marker = line.indexOf("⎿");
	if (marker >= 0) return line.slice(marker + 1).replace(/^\s+/, "");
	return line.replace(/^\s+/, "");
}

function formatGroup(lines: string[]): string[] {
	if (!lines.length) return [];
	const header = normalizeStatusGlyph(lines[0]!);
	const rest = lines.slice(1);
	const detailStart = rest.findIndex(isDetail);
	if (detailStart < 0) return [header, ...rest];
	const metadata = rest.slice(0, detailStart);
	const details = rest
		.slice(detailStart)
		.map(cleanDetail)
		.filter((line) => plain(line).trim());
	return [
		header,
		...metadata,
		...details.map((line, index) => `${index === details.length - 1 ? "└" : "├"} ${line}`),
	];
}

export function formatSubagentNotificationLines(lines: string[], width: number): string[] {
	const groups: string[][] = [];
	for (const line of trimBlankLines(lines)) {
		if (isHeader(line) && groups.length && groups.at(-1)!.length) groups.push([]);
		if (!groups.length) groups.push([]);
		groups.at(-1)!.push(line);
	}
	return groups.flatMap((group, index) => {
		const formatted = formatGroup(group).map((line) =>
			truncateToWidth(line ? ` ${line}` : line, Math.max(1, width), ""),
		);
		return index ? ["", ...formatted] : formatted;
	});
}

export default function subagentNotificationExtension(pi: ExtensionAPI): void {
	let patch: Patch | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (patch || ctx?.mode !== "tui" || !ctx?.hasUI) return;
		const prototype = CustomMessageComponent.prototype as any;
		const host = globalThis as any;
		const previous = host[PATCH_KEY] as Patch | undefined;
		if (previous) previous.active = false;
		const originalRender =
			previous && prototype.render === previous.installedRender
				? previous.originalRender
				: prototype.render;
		patch = {
			active: true,
			prototype,
			originalRender,
			installedRender: undefined as any,
		};
		const installed = patch;
		installed.installedRender = function (this: any, width: number): string[] {
			const lines = originalRender.call(this, width);
			if (!installed.active || this?.message?.customType !== "subagent-notification") return lines;
			return formatSubagentNotificationLines(lines, width);
		};
		prototype.render = installed.installedRender;
		host[PATCH_KEY] = installed;
	});

	pi.on("session_shutdown", async () => {
		if (!patch?.active) return;
		patch.active = false;
		if (patch.prototype.render === patch.installedRender)
			patch.prototype.render = patch.originalRender;
	});
}
