import assert from "node:assert/strict";
import test from "node:test";
import {
	bottomDialogBounds,
	centeredDialogBounds,
	isDialogCloseClick,
	renderDialogHeader,
	renderDialogTopBorder,
} from "../extensions/closable-dialog.ts";

const plain = (text: string) => text;

test("dialog header keeps the close button off the border and enlarges its hit target", () => {
	assert.equal(renderDialogTopBorder(16, plain), "╭──────────────╮");
	assert.equal(renderDialogHeader("Title", 16, plain, plain, plain), "│Title    [ × ]│");
	const bounds = { left: 5, top: 3, width: 16 };
	for (let col = 14; col <= 18; col++) {
		assert.equal(isDialogCloseClick(`\x1b[<0;${col};4M`, bounds), true);
	}
	assert.equal(isDialogCloseClick("\x1b[<0;13;4M", bounds), false);
	assert.equal(isDialogCloseClick("\x1b[<0;14;3M", bounds), false);
});

test("dialog bounds support centered overlays and bottom temporary editors", () => {
	assert.deepEqual(centeredDialogBounds({ columns: 100, rows: 40 }, 60, 20), {
		left: 21,
		top: 11,
		width: 60,
	});
	assert.deepEqual(bottomDialogBounds({ rows: 40 }, 100, 12), {
		left: 1,
		top: 29,
		width: 100,
	});
});
