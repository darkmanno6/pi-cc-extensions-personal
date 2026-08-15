import assert from "node:assert/strict";
import test from "node:test";

import { PatchRegistry, patchRegistry } from "../extensions/utils/patch-keys.ts";

/** 独立 host 的注册表：不触碰 globalThis，测试间无泄漏。 */
function isolatedRegistry(): PatchRegistry {
	return new PatchRegistry({});
}

test("install overwrites and returns the previous value", () => {
	const registry = isolatedRegistry();
	const key = Symbol("install");
	const first = { id: "first" };
	const second = { id: "second" };

	assert.equal(registry.install(key, first), undefined);
	assert.equal(registry.get(key), first);
	assert.equal(registry.install(key, second), first);
	assert.equal(registry.get(key), second);
});

test("dispose only deletes when still owned (stale module guard)", () => {
	const registry = isolatedRegistry();
	const key = Symbol("dispose");
	const stale = { id: "stale" };
	const current = { id: "current" };

	registry.install(key, stale);
	registry.install(key, current);

	// 旧模块释放时，槽位已由新模块持有：不得误删。
	assert.equal(registry.dispose(key, stale), false);
	assert.equal(registry.get(key), current);

	// 当前持有者释放：删除成功。
	assert.equal(registry.dispose(key, current), true);
	assert.equal(registry.get(key), undefined);
});

test("owns reports identity ownership", () => {
	const registry = isolatedRegistry();
	const key = Symbol("owns");
	const mine = { id: "mine" };

	assert.equal(registry.owns(key, mine), false);
	registry.install(key, mine);
	assert.equal(registry.owns(key, mine), true);
	assert.equal(registry.owns(key, { id: "mine" }), false, "equal-but-distinct object is not owner");
});

test("ensure lazily initializes once and preserves existing values", () => {
	const registry = isolatedRegistry();
	const key = Symbol("ensure");
	let inits = 0;
	const init = () => {
		inits++;
		return { value: inits };
	};

	const first = registry.ensure(key, init);
	const second = registry.ensure(key, init);
	assert.equal(first, second, "same cached object");
	assert.equal(inits, 1, "init ran exactly once");
	assert.deepEqual(first, { value: 1 });

	// ??= 语义：null/undefined 视为未初始化。
	const nullKey = Symbol("ensure-null");
	registry.install(nullKey, null);
	assert.deepEqual(
		registry.ensure(nullKey, () => ({ value: 2 })),
		{ value: 2 },
	);
});

test("delete clears unconditionally and reports presence", () => {
	const registry = isolatedRegistry();
	const key = Symbol("delete");

	assert.equal(registry.delete(key), false);
	registry.install(key, { id: "x" });
	assert.equal(registry.delete(key), true);
	assert.equal(registry.get(key), undefined);
	assert.equal(registry.delete(key), false);
});

test("singleton storage is globalThis, so direct reads stay compatible", () => {
	const key = Symbol.for("pi.ccstyle.test.patch-registry");
	try {
		patchRegistry.install(key, { tag: "via-registry" });
		const direct = (globalThis as Record<PropertyKey, unknown>)[key] as { tag: string };
		assert.equal(direct.tag, "via-registry");

		(globalThis as Record<PropertyKey, unknown>)[key] = { tag: "via-globalThis" };
		assert.equal(patchRegistry.get<{ tag: string }>(key)?.tag, "via-globalThis");
	} finally {
		patchRegistry.delete(key);
	}
});
