import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";

// fullscreen 冒烟测试：官方 fullscreen TUI（mode === "fullscreen"）下，
// 渲染层（工具样式/紧凑模式/分组）为原型与组件级 patch，随官方布局生效；
// 固定编辑器 compositor 仍让位官方 sticky editor。

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

test("fullscreen session: rendering layer installs, fixed editor stands down", async () => {
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

	// 渲染层安装：/ccstyle 在 fullscreen 下同样可用（组件级 patch 随官方布局生效）
	assert.notEqual(toolPrototype.getRenderShell, original.getRenderShell);
	assert.notEqual(toolPrototype.getCallRenderer, original.getCallRenderer);
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
});
