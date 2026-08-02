import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package manifest only lists extension factory entry points", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
});
