import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

import { shouldRenderRichDiff } from "../extensions/renderer/index.ts";
import {
	renderEditDiffResult,
	renderWriteDiffResult,
} from "../extensions/renderer/tool-diff/diff-renderer.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	installWriteOverride,
	renderRichToolResult,
	WriteExecutionMetadataStore,
	type ToolDisplayConfig,
} from "../extensions/renderer/tool-diff/index.ts";
import {
	executeWriteWithMetadata,
	MAX_COMPARABLE_WRITE_BYTES,
	MAX_WRITE_METADATA_ENTRIES,
} from "../extensions/renderer/tool-diff/write-execution.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

function output(component: any, width = 100): string[] {
	return component.render(width);
}

test("rich diff routes only successful edit/write results in on mode", () => {
	for (const mode of ["on", "off"] as const) {
		assert.equal(shouldRenderRichDiff(mode, "edit", false), mode === "on");
		assert.equal(shouldRenderRichDiff(mode, "write", false), mode === "on");
		assert.equal(shouldRenderRichDiff(mode, "read", false), false);
		assert.equal(shouldRenderRichDiff(mode, "edit", true), false);
	}
});

test("edit rich diff is width-safe and honors collapsed/expanded limits", () => {
	const diff = ["@@ -1,40 +1,40 @@"];
	for (let index = 1; index <= 40; index++) {
		diff.push(`-${index}|old value ${index}`, `+${index}|new value ${index}`);
	}
	const store = new WriteExecutionMetadataStore();
	const collapsed = renderRichToolResult(
		"edit",
		{ details: { diff: diff.join("\n") }, content: [] },
		{ expanded: false },
		theme,
		{ args: { path: "sample.ts" } },
		store,
	);
	const collapsedLines = output(collapsed, 32);
	assert.ok(collapsedLines.some((line) => line.includes("more")));
	assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 32));

	const expanded = renderRichToolResult(
		"edit",
		{ details: { diff: diff.join("\n") }, content: [] },
		{ expanded: true },
		theme,
		{ args: { path: "sample.ts" } },
		store,
	);
	assert.ok(output(expanded, 32).length > collapsedLines.length);
});

test("edit/write collapsed diff hints switch from muted to white text on hover", () => {
	let hovered = false;
	const hoverTheme = {
		...theme,
		fg(color: string, text: string) {
			const code = color === "muted" ? "\x1b[90m" : color === "text" ? "\x1b[97m" : "\x1b[37m";
			return `${code}${text}\x1b[39m`;
		},
	};
	const diff = [
		"@@ -1,40 +1,40 @@",
		...Array.from({ length: 40 }, (_, index) => ` ${index + 1}|const value${index} = ${index}`),
		"-41|const oldValue = 1",
		"+41|const oldValue = 2",
	].join("\n");
	const component = renderEditDiffResult(
		{ diff },
		{ expanded: false, filePath: "sample.ts", isHovered: () => hovered },
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffCollapsedLines: 2 },
		hoverTheme,
		"",
	);
	const hint = () => output(component).find((line) => line.includes("click to show more")) ?? "";
	assert.match(hint(), /\x1b\[90m/, "resting edit hint uses muted color");
	hovered = true;
	assert.match(hint(), /\x1b\[90m[^\n]*• [^\n]*\x1b\[39m\x1b\[97mclick to show more/);
	assert.doesNotMatch(hint(), /\x1b\[97m[^\n]*•/, "edit separator dot stays muted");

	hovered = false;
	const writeComponent = renderWriteDiffResult(
		Array.from({ length: 40 }, (_, index) => `const value${index} = ${index}`).join("\n"),
		{
			expanded: false,
			filePath: "sample.ts",
			fileExistedBeforeWrite: false,
			isHovered: () => hovered,
		},
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, diffCollapsedLines: 2 },
		hoverTheme,
		"",
	);
	const writeHint = () =>
		output(writeComponent).find((line) => line.includes("click to show more")) ?? "";
	assert.match(writeHint(), /\x1b\[90m/, "resting write hint uses muted color");
	hovered = true;
	assert.match(writeHint(), /\x1b\[90m[^\n]*• [^\n]*\x1b\[39m\x1b\[97mclick to show more/);
	assert.doesNotMatch(writeHint(), /\x1b\[97m[^\n]*•/, "write separator dot stays muted");
});

test("diff indicator mode live-updates on the same component via config getter", () => {
	// Panel changes must repaint existing tool rows without re-running the tool.
	let display: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		diffViewMode: "unified",
		diffIndicatorMode: "classic",
		diffCollapsedLines: 80,
		expandedPreviewMaxLines: 200,
	};
	const component = renderRichToolResult(
		"edit",
		{
			details: { diff: "@@ -1,1 +1,2 @@\n 1|same line\n+2|added line" },
			content: [],
		},
		{ expanded: true },
		theme,
		{ args: { path: "sample.ts" } },
		new WriteExecutionMetadataStore(),
		() => display,
	);
	assert.ok(component, "edit rich diff should render");

	const classicText = output(component, 80).join("\n");
	assert.match(classicText, /\+.*added line/, "classic mode uses +/- content markers");
	assert.doesNotMatch(
		classicText,
		/• \d+ hunks? • \d+ files?/,
		"unified headers omit redundant hunk and file counts",
	);

	display = { ...display, diffIndicatorMode: "bars" };
	const barsText = output(component, 80).join("\n");
	assert.match(barsText, /▌/, "bars mode uses vertical bar markers");
	assert.notEqual(barsText, classicText, "cache must miss when indicator mode changes");

	display = { ...display, diffIndicatorMode: "none" };
	const noneText = output(component, 80).join("\n");
	assert.doesNotMatch(noneText, /▌/);
	// none: no classic + before added content either (still may contain + in header stats).
	const bodyLines = noneText.split("\n").filter((line) => line.includes("added line"));
	assert.ok(bodyLines.length > 0);
	assert.ok(
		bodyLines.every((line) => !/^\s*\+/.test(line.replace(/^\s*\d+\s*/, ""))),
		"none mode should not prefix added body lines with +",
	);
});

test("split diff keeps the panel transparent while highlighting changed rows", () => {
	const panelBackground = "\x1b[48;2;1;2;3m";
	const ansiTheme = {
		...theme,
		getBgAnsi(color: string) {
			return color === "toolSuccessBg" ? panelBackground : undefined;
		},
	} as any;
	const rendered = renderRichToolResult(
		"edit",
		{
			details: { diff: "@@ -1,2 +1,2 @@\n 1|same\n-2|old\n+2|new" },
			content: [],
		},
		{ expanded: true },
		ansiTheme,
		{ args: { path: "sample.ts" } },
		new WriteExecutionMetadataStore(),
	);
	const text = output(rendered, 140).join("\n");
	assert.equal(text.includes(panelBackground), false);
	assert.match(text, /\x1b\[48;2;/);
});

test("final edit/write diff output removes terminal command injection", () => {
	const osc = "\x1b]52;c;OSC_PAYLOAD\x07";
	const dcs = "\x1bP1;2|DCS_PAYLOAD\x9c";
	const csi = "\x1b[2J";
	const edit = renderEditDiffResult(
		{
			diff: [
				`diff --git a/safe.ts b/safe${osc}.ts`,
				`--- a/safe.ts${dcs}`,
				"+++ b/safe.ts",
				`@@ -1 +1 @@${osc}`,
				`meta${dcs}`,
				`+1|const safe = 1;${csi}`,
			].join("\n"),
		},
		{ expanded: true, filePath: "safe.ts" },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	const write = renderWriteDiffResult(
		`const safe = 1;${osc}${dcs}${csi}`,
		{ expanded: true, filePath: "safe.ts" },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		"",
	);
	const editFallback = renderEditDiffResult(
		{},
		{ expanded: true },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		`fallback${osc}${dcs}${csi}`,
	);
	const writeFallback = renderWriteDiffResult(
		undefined,
		{ expanded: true },
		DEFAULT_TOOL_DISPLAY_CONFIG,
		theme,
		`fallback${osc}${dcs}${csi}`,
	);

	for (const rendered of [edit, write, editFallback, writeFallback]) {
		const text = output(rendered).join("\n");
		assert.doesNotMatch(text, /OSC_PAYLOAD|DCS_PAYLOAD|\x1b\[2J|\x1b\]|\x1bP|[\x90\x9c\x9d]/);
	}
});

test("write create and overwrite render distinct rich diffs", () => {
	const store = new WriteExecutionMetadataStore();
	store.set("create", { fileExistedBeforeWrite: false });
	store.set("overwrite", { fileExistedBeforeWrite: true, previousContent: "old\n" });
	const create = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false },
		theme,
		{ toolCallId: "create", args: { path: "new.ts", content: "new\n" } },
		store,
	);
	const overwrite = renderRichToolResult(
		"write",
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false },
		theme,
		{ toolCallId: "overwrite", args: { path: "old.ts", content: "new\n" } },
		store,
	);
	assert.match(output(create).join("\n"), /created/);
	const overwriteText = output(overwrite).join("\n");
	assert.match(overwriteText, /overwritten/);
	assert.match(overwriteText, /old/);
	assert.match(overwriteText, /new/);
});

test("missing and unavailable write metadata never masquerade as create", () => {
	const store = new WriteExecutionMetadataStore();
	store.set("large", {
		fileExistedBeforeWrite: true,
		diffUnavailableReason: `previous file exceeds ${MAX_COMPARABLE_WRITE_BYTES} bytes`,
	});
	for (const toolCallId of ["missing", "large"]) {
		const rendered = renderRichToolResult(
			"write",
			{ content: [{ type: "text", text: "ok" }] },
			{},
			theme,
			{ toolCallId, args: { path: "file.ts", content: "new" } },
			store,
		);
		assert.match(output(rendered, 28).join("\n"), /diff unavailable/);
		assert.ok(output(rendered, 28).every((line) => visibleWidth(line) <= 28));
	}
});

test("write execution captures the 512000-byte boundary and degrades above it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ccstyle-diff-"));
	const path = join(directory, "target.txt");
	const store = new WriteExecutionMetadataStore();
	try {
		await writeFile(path, "a".repeat(MAX_COMPARABLE_WRITE_BYTES));
		const result = await executeWriteWithMetadata(
			store,
			"boundary",
			{ path, content: "boundary replacement" },
			undefined,
			directory,
		);
		assert.equal(store.get("boundary")?.previousContent?.length, MAX_COMPARABLE_WRITE_BYTES);
		assert.equal(result.details, undefined);

		await writeFile(path, "b".repeat(MAX_COMPARABLE_WRITE_BYTES + 1));
		await executeWriteWithMetadata(
			store,
			"large",
			{ path, content: "large replacement" },
			undefined,
			directory,
		);
		assert.equal(store.get("large")?.fileExistedBeforeWrite, true);
		assert.match(store.get("large")?.diffUnavailableReason ?? "", /exceeds/);
		assert.equal(await readFile(path, "utf8"), "large replacement");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("write metadata is bounded, clearable, and failures do not retain entries", async () => {
	const store = new WriteExecutionMetadataStore();
	for (let index = 0; index <= MAX_WRITE_METADATA_ENTRIES; index++) {
		store.set(String(index), { fileExistedBeforeWrite: false });
	}
	assert.equal(store.entries.size, MAX_WRITE_METADATA_ENTRIES);
	assert.equal(store.get("0"), undefined);
	store.clear();
	assert.equal(store.entries.size, 0);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		executeWriteWithMetadata(
			store,
			"failed",
			{ path: join(tmpdir(), "never-written.txt"), content: "x" },
			controller.signal,
			tmpdir(),
		),
		/aborted/,
	);
	assert.equal(store.get("failed"), undefined);
});

test("third-party write ownership prevents registration", () => {
	const registered: unknown[] = [];
	installWriteOverride({
		getAllTools() {
			return [{ name: "write", sourceInfo: { source: "extension", path: "other.ts" } }];
		},
		registerTool(tool: unknown) {
			registered.push(tool);
		},
	} as any);
	assert.deepEqual(registered, []);
});
