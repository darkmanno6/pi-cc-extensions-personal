import assert from "node:assert/strict";
import test from "node:test";

import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";
import piStartupHeader from "../extensions/feature/shell/startup-header.ts";
import claudeCodeStyleExtension, {
	getCompactThinkingConfig,
} from "../extensions/renderer/index.ts";
import { SESSION_HANDOFF_KEY } from "../extensions/utils/patch-keys.ts";

/** Mimics pi: reading any ctx field after the session is replaced throws. */
function guardedCtx() {
	let stale = false;
	const ctx = new Proxy(
		{
			mode: "tui",
			hasUI: true,
			sessionManager: { getEntries: () => [] },
			ui: {
				theme: { fg: (_color: string, text: string) => text },
				setHeader() {},
				setWidget() {},
				setStatus() {},
				requestRender() {},
			},
		},
		{
			get(target: any, key) {
				if (stale) {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				}
				return target[key];
			},
		},
	);
	return { ctx: ctx as any, invalidate: () => (stale = true) };
}

function runtime() {
	const events = new Map<string, Function[]>();
	return {
		events,
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, [...(events.get(name) ?? []), handler]);
			},
		},
		async emit(name: string, event: any, ctx: any) {
			for (const handler of events.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("header handoff never touches the replaced session ctx", async (t) => {
	(t.mock.timers as any).enable({ apis: ["setTimeout"] });
	const { ctx, invalidate } = guardedCtx();
	const { pi, emit } = runtime();
	piStartupHeader(pi as any);

	await emit("session_start", {}, ctx);
	await emit("session_shutdown", { reason: "reload" }, ctx);
	// Pi invalidates the ctx as part of the reload; anything deferred must not read it.
	invalidate();
	(t.mock.timers as any).tick(1500);
});

test("renderer handoff grace period tears down without the stale ctx", async (t) => {
	(t.mock.timers as any).enable({ apis: ["setTimeout"] });
	const { ctx, invalidate } = guardedCtx();
	const { pi, emit } = runtime();
	claudeCodeStyleExtension(
		pi as any,
		{ mode: "on" },
		installCompactThinking(pi as any, getCompactThinkingConfig()),
	);

	await emit("session_start", {}, ctx);
	(t.mock.timers as any).tick(0);
	await emit("session_shutdown", { reason: "resume" }, ctx);
	assert.notEqual((globalThis as any)[SESSION_HANDOFF_KEY], undefined);

	invalidate();
	(t.mock.timers as any).tick(1500);
	assert.equal((globalThis as any)[SESSION_HANDOFF_KEY], undefined);
});
