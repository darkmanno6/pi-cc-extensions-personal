import assert from "node:assert/strict";
import test from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import claudeCodeStyleExtension, { installToolMouseInteraction } from "../extensions/claude-code-style.ts";
import { installFixedEditor } from "../extensions/fixed-editor.ts";

// 0.84+ 惰性 Proxy 回归测试：官方 tui 引用（createInteractiveTuiReference）对函数
// 属性每次 get 返回新包装。通过 proxy 捕获 doRender/handleInput 会解析到 wrapper
// 自身形成无限递归 —— 插件必须跳过所有"捕获后包装"类 patch，compositor 安装亦然。

initTheme("dark");

/** 模拟官方 0.84.0 的惰性 Proxy（createInteractiveTuiReference 语义）。 */
function createLazyProxy(renderer: any) {
	return new Proxy(
		{},
		{
			get: (_t, p) => {
				const tui = renderer;
				const v = Reflect.get(tui, p, tui);
				if (typeof v !== "function") return v;
				return (...args: any[]) => {
					const m = Reflect.get(tui, p, tui);
					if (typeof m !== "function") throw new TypeError(`not callable: ${String(p)}`);
					return Reflect.apply(m, tui, args);
				};
			},
			set: (_t, p, v) => Reflect.set(renderer, p, v),
			has: (_t, p) => Reflect.has(renderer, p),
			getPrototypeOf: () => Reflect.getPrototypeOf(renderer),
		},
	);
}

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

test("lazy-proxy tui: doRender/handleInput patches stand down (no recursion)", async () => {
	class Renderer {
		mode = "regular";
		doRenderCalls = 0;
		requestRender() {}
		render(width: number) {
			return ["line"];
		}
		doRender() {
			this.doRenderCalls++;
			this.render(80);
		}
		handleInput(_data: string) {}
	}
	const renderer = new Renderer();
	const tui = createLazyProxy(renderer);
	let terminalInputCalls = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: theme(),
			setStatus() {},
			requestRender() {},
			setWidget(_key: string, content: any) {
				if (typeof content === "function") content(tui, theme());
			},
			onTerminalInput() {
				terminalInputCalls++;
				return () => {};
			},
			notify() {},
			setFooter() {},
		},
	} as any;

	const { pi, events } = runtime();
	claudeCodeStyleExtension(pi as any, { mode: "on", fixedEditorFeatures: true });
	await events.get("session_start")?.({}, ctx);

	// 渲染不应递归：proxy 捕获的包装不得被安装为 doRender/handleInput。
	renderer.doRender();
	renderer.handleInput("x");
	assert.equal(renderer.doRenderCalls, 1);

	// 整个工具鼠标交互体系不启动：不注册 onTerminalInput 监听。
	assert.equal(terminalInputCalls, 0);

	// compositor install 被拦截：FixedEditorOwner 未建立，compositor 不接管渲染。
	assert.equal((globalThis as any)[Symbol.for("pi.ccstyle.fixed-editor-owner")], undefined);
});
