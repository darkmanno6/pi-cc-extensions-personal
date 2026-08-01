// escCloseHitbox 的契约：
// [esc] 按钮位于弹框标题行（box 第 2 行）右端，5 列宽；
// bounds 为 0-based 的弹框起点（left/top）+ 宽度。
import assert from "node:assert/strict";
import test from "node:test";
import { escCloseHitbox } from "../extensions/context.ts";

test("escCloseHitbox places the [esc] hitbox at the right end of the title row", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
});

test("escCloseHitbox keeps the hitbox inside a narrow box", () => {
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
});

test("escCloseHitbox follows a non-top dialog row", () => {
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

test("escCloseHitbox hitbox is 5 columns wide and flush to the right content edge", () => {
	const cases: { left: number; top: number; width: number }[] = [
		{ left: 8, top: 1, width: 64 },
		{ left: 1, top: 1, width: 38 },
		{ left: 20, top: 6, width: 50 },
	];
	for (const bounds of cases) {
		const hitbox = escCloseHitbox(bounds);
		assert.equal(hitbox.endCol - hitbox.startCol + 1, 5, "hitbox is exactly 5 columns wide");
		assert.ok(hitbox.startCol > bounds.left, "hitbox starts inside the box");
		assert.ok(hitbox.endCol < bounds.left + bounds.width, "hitbox ends inside the box");
	}
});
