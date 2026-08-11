import assert from "node:assert/strict";
import test from "node:test";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";

// 回归：jiti 转译下经 re-export 链读取的模块级 let 绑定是初始值快照（死绑定），
// 跨模块读取必须走 getToolMouseTui()（globalThis Symbol 槽镜像），否则 resume
// 后 collectMountedComponents 永远收到 null，compact 摘要不重绘。
test("toolMouseTui getter reads the global slot written by setter", () => {
	const tui = { mode: "regular" };
	try {
		setToolMouseTui(tui);
		assert.equal(getToolMouseTui(), tui, "getter must return the instance set via setter");
	} finally {
		setToolMouseTui(null);
	}
	assert.equal(getToolMouseTui(), null, "cleared state must read back as null");
});
