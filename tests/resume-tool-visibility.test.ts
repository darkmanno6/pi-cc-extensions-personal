import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import claudeCodeStyle, { getCompactThinkingConfig } from "../extensions/renderer/index.ts";
import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";
import { RENDER_MANAGES_THINKING_KEY } from "../extensions/utils/patch-keys.ts";

initTheme("dark");

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			appendEntry() {},
		} as any,
		emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();

function makeCtx(parent: Container, sessionManager: any) {
	const theme = { fg: (_c: string, t: string) => t };
	const tui: any = {
		mode: "regular",
		getMountedRoots: () => [parent],
		terminal: { columns: 120, rows: 40, write() {} },
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
	};
	return {
		tui,
		ctx: {
			mode: "tui",
			hasUI: true,
			sessionManager,
			ui: {
				theme,
				setStatus() {},
				notify() {},
				requestRender() {},
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function") factory(tui);
				},
				onTerminalInput() {
					return () => {};
				},
			},
		} as any,
	};
}

// Replacement-session shutdown keeps the renderer patch alive while Pi rebuilds
// history, preventing a native first frame. The next runtime then takes ownership.
test("restored tool keeps Claude rendering across resume ownership transfer", async () => {
	const originalAssistantUpdate = AssistantMessageComponent.prototype.updateContent;
	const originalToolUpdate = (ToolExecutionComponent.prototype as any).updateDisplay;
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-resume-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const parent = new Container() as any;
	const { ctx } = makeCtx(parent, { getBranch: () => [], getEntries: () => [] });
	const bashDefinition = {
		name: "bash",
		renderCall: () => ({ render: () => ["$ bash"], invalidate() {} }),
		renderResult: () => ({ render: () => ["out"], invalidate() {} }),
	} as any;

	const first = runtime();
	try {
		const firstThinking = installCompactThinking(first.pi, getCompactThinkingConfig());
		claudeCodeStyle(first.pi as any, { mode: "on" }, firstThinking);
		first.emit("session_start", {}, ctx);
		first.emit("session_shutdown", { reason: "resume" }, ctx);

		// Pi rebuilds history before the next session_start; the old patch still owns
		// the prototype, so this component is Claude-styled on its first frame.
		const tool = new ToolExecutionComponent(
			"bash",
			"c1",
			{},
			{},
			bashDefinition,
			ctx.ui,
			process.cwd(),
		) as any;
		tool.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		parent.addChild(tool);
		assert.equal(tool.getRenderShell(), "self", "Claude shell survives resume rebuild");

		// The new extension instance takes ownership without exposing a native frame.
		const second = runtime();
		const secondThinking = installCompactThinking(second.pi, getCompactThinkingConfig());
		claudeCodeStyle(second.pi as any, { mode: "on" }, secondThinking);
		second.emit("session_start", { reason: "resume" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const manager = (globalThis as any)[RENDER_MANAGES_THINKING_KEY];
		assert.ok(manager?.rendererOwner);
		assert.ok(manager?.thinkingOwner);

		const lines = parent.render(120).map(stripAnsi).filter(Boolean);
		assert.ok(
			lines.some((l: string) => /bash|out|returned/i.test(l)),
			`tool must stay visible after resume, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", { reason: "quit" }, ctx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, originalAssistantUpdate);
		assert.equal((ToolExecutionComponent.prototype as any).updateDisplay, originalToolUpdate);
		assert.equal((globalThis as any)[RENDER_MANAGES_THINKING_KEY], undefined);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
