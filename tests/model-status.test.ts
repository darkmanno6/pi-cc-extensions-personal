import assert from "node:assert/strict";
import test from "node:test";
import modelStatus from "../extensions/feature/shell/model-status.ts";

function install() {
	const events = new Map<string, Function>();
	const statuses: { key: string; text: string | undefined }[] = [];
	modelStatus({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const ui = {
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
	};
	return { events, statuses, ui };
}

test("model status uses name over id and does not call setFooter", async () => {
	const { events, statuses, ui } = install();
	const ctx: {
		hasUI: boolean;
		ui: typeof ui;
		model?: { provider?: string; name?: string; id?: string };
	} = {
		hasUI: true,
		ui,
		model: {
			provider: "anthropic",
			name: "claude-sonnet-4-5",
			id: "anthropic/claude-sonnet-4-5-20250929",
		},
	};

	await events.get("session_start")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "model", text: "anthropic · claude-sonnet-4-5" });
	assert.equal("setFooter" in ui, false);

	ctx.model = { provider: "openrouter", id: "openrouter/foo-bar" };
	await events.get("model_select")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "model", text: "openrouter · openrouter/foo-bar" });

	ctx.model = undefined;
	await events.get("model_select")?.({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "model", text: undefined });
});
