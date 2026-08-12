import assert from "node:assert/strict";
import test from "node:test";
import { setHoveredToolCallId } from "../extensions/renderer/mouse/hover.ts";
import * as interaction from "../extensions/renderer/mouse/interaction.ts";

// 回归：interaction.ts 末尾的 re-export 仅保留兼容旧 deep import（发布包含
// 整个 extensions 目录，外部扩展可能直接从此模块导入这些符号），删除会破坏外部加载。
test("interaction.ts 保留旧鼠标符号的兼容 re-export", () => {
	assert.equal(typeof interaction.toolMouseTui, "object");
	assert.equal(typeof interaction.isToolCallHovered, "function");
	assert.equal(typeof interaction.setHoveredToolGroup, "function");
	assert.equal(typeof interaction.setHoveredToolIo, "function");
	assert.equal("hoveredToolCallId" in interaction, true);
});

test("hoveredToolCallId 随 setter 保持 live（读到的不是初始快照）", () => {
	try {
		setHoveredToolCallId("tool-1");
		assert.equal(interaction.hoveredToolCallId, "tool-1");
	} finally {
		setHoveredToolCallId(null);
	}
	assert.equal(interaction.hoveredToolCallId, null);
});
