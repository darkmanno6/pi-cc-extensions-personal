import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

import { installCompactThinking } from "../extensions/compact-thinking.ts";

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	previewLines: 0,
	animationIntervalMs: 30,
};

function runtime() {
	const handlers = new Map<string, Function>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
			appendEntry() {},
		} as any,
	};
}

const ctx = {
	mode: "tui",
	sessionManager: { getBranch: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

test("compact thinking patches the runtime component and mirrors ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { handlers, pi } = runtime();
	writeFileSync(join(dir, "compact-thinking.json"), "invalid", "utf8");
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "compact-thinking.json"), "utf8")), config);
	} finally {
		handlers.get("session_shutdown")?.({}, {});
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps the replacement compact-thinking prototype patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installCompactThinking(first.pi, config);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;
		first.handlers.get("session_start")?.({}, ctx);

		installCompactThinking(second.pi, config);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
