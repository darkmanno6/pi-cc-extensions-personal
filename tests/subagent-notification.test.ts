import assert from "node:assert/strict";
import test from "node:test";
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent";
import subagentNotificationExtension, {
	formatSubagentNotificationLines,
} from "../extensions/subagent-notification.ts";

test("subagent notifications use compact status and detail tree rows", () => {
	assert.deepEqual(
		formatSubagentNotificationLines(
			["", "✓ reviewer fixed the issue", "  transcript: session-1", ""],
			80,
		),
		[" ● reviewer fixed the issue", " └ transcript: session-1"],
	);
});

test("subagent notification patch is selective and reload-safe", async () => {
	const prototype = CustomMessageComponent.prototype as any;
	const hostRender = prototype.render;
	const eventsA = new Map<string, Function>();
	const eventsB = new Map<string, Function>();
	prototype.render = () => ["✓ reviewer summary"];
	try {
		subagentNotificationExtension({
			on(name: string, handler: Function) {
				eventsA.set(name, handler);
			},
		} as any);
		subagentNotificationExtension({
			on(name: string, handler: Function) {
				eventsB.set(name, handler);
			},
		} as any);
		const ctx = { mode: "tui", hasUI: true };
		await eventsA.get("session_start")?.({}, ctx);
		await eventsB.get("session_start")?.({}, ctx);

		const notification = Object.assign(Object.create(prototype), {
			message: { customType: "subagent-notification" },
		});
		const ordinary = Object.assign(Object.create(prototype), {
			message: { customType: "other" },
		});
		assert.deepEqual(notification.render(80), [" ● reviewer summary"]);
		assert.deepEqual(ordinary.render(80), ["✓ reviewer summary"]);

		await eventsA.get("session_shutdown")?.();
		assert.deepEqual(notification.render(80), [" ● reviewer summary"]);
		await eventsB.get("session_shutdown")?.();
		assert.deepEqual(prototype.render(), ["✓ reviewer summary"]);
	} finally {
		prototype.render = hostRender;
	}
});
