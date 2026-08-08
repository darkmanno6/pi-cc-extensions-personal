// fullscreen 模式探测：官方 fullscreen TUI（TuiAltScreen）由官方独占布局，
// 插件渲染层应让位。检测方式是瞬时 setWidget 拿 tui 实例检查 mode。
const PROBE_KEY = "cc-fullscreen-probe";

/**
 * 官方 0.84+ 的 tui 引用是惰性 Proxy（createInteractiveTuiReference）：
 * 函数属性每次 get 都返回新包装，执行时才解析到当前实现。
 * 通过它捕获 doRender/render/handleInput 会解析到自身形成无限递归，
 * 因此检测到惰性 Proxy 时必须跳过所有"捕获后包装"类 patch。
 */
export function isLazyProxyTui(tui: any): boolean {
	if (!tui || typeof tui !== "object") return false;
	const probe = tui.requestRender;
	return typeof probe === "function" && probe !== tui.requestRender;
}

/**
 * 探测当前会话的 TUI 是否运行在官方 fullscreen 模式。
 * 无 setWidget 的环境（测试 mock）视为 regular。
 */
export function isFullscreenUi(ctx: { ui?: any }): boolean {
	if (typeof ctx?.ui?.setWidget !== "function") return false;
	let fullscreen = false;
	try {
		ctx.ui.setWidget(PROBE_KEY, (tui: any) => {
			fullscreen = tui?.mode === "fullscreen";
			return { render: () => 0, invalidate() {} };
		});
	} catch {
		// 探测失败按 regular 处理，避免误伤
	}
	try {
		ctx.ui.setWidget(PROBE_KEY, undefined);
	} catch {
		// 忽略
	}
	return fullscreen;
}
