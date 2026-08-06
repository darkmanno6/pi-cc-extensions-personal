import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import claudeCodeStyleExtension from "../extensions/claude-code-style.ts";

// fullscreen 冒烟测试：官方 fullscreen TUI（mode === "fullscreen"）下，
// 插件渲染层必须让位 —— 不安装全局工具渲染 patch、不激活固定编辑器。

const FIXED_EDITOR_OWNER = Symbol.for("pi.ccstyle.fixed-editor-owner");

function runtime() {
	const events = new Map<string, Function>();
	return {
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
		events,
	};
}

function theme() {
	return { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
}

/** ctx.ui.setWidget 同步调用 factory（与官方一致），并返回指定 mode 的 tui。 */
function ctxWithTuiMode(mode: string) {
	const tui = { mode };
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: theme(),
			setStatus() {},
			requestRender() {},
			setWidget(_key: string, content: any) {
				if (typeof content === "function") content(tui, theme());
			},
		},
	} as any;
}

test("fullscreen session: rendering layer stands down", async () => {
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const original = {
		hasRendererDefinition: toolPrototype.hasRendererDefinition,
		getRenderShell: toolPrototype.getRenderShell,
		getCallRenderer: toolPrototype.getCallRenderer,
		getResultRenderer: toolPrototype.getResultRenderer,
	};
	const { pi, events } = runtime();
	claudeCodeStyleExtension(pi as any, { mode: "on" });
	await events.get("session_start")?.({}, ctxWithTuiMode("fullscreen"));

	// 全局工具渲染 patch 未安装
	assert.equal(toolPrototype.hasRendererDefinition, original.hasRendererDefinition);
	assert.equal(toolPrototype.getRenderShell, original.getRenderShell);
	assert.equal(toolPrototype.getCallRenderer, original.getCallRenderer);
	assert.equal(toolPrototype.getResultRenderer, original.getResultRenderer);
	// 固定编辑器未激活
	assert.equal((globalThis as any)[FIXED_EDITOR_OWNER], undefined);
});

test("regular session: rendering layer still installs", async () => {
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const original = {
		hasRendererDefinition: toolPrototype.hasRendererDefinition,
		getRenderShell: toolPrototype.getRenderShell,
		getCallRenderer: toolPrototype.getCallRenderer,
		getResultRenderer: toolPrototype.getResultRenderer,
	};
	const { pi, events } = runtime();
	claudeCodeStyleExtension(pi as any, { mode: "on" });
	await events.get("session_start")?.({}, ctxWithTuiMode("regular"));

	assert.notEqual(toolPrototype.getRenderShell, original.getRenderShell);
	assert.equal((globalThis as any)[FIXED_EDITOR_OWNER]?.owner, undefined);
	// 清理，避免影响其他测试进程内断言
	(globalThis as any)[FIXED_EDITOR_OWNER]?.stop?.();
	delete (globalThis as any)[FIXED_EDITOR_OWNER];
});
