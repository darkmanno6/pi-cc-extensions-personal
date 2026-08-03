import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
};

export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
};

type CompactThinkingOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

const COMPACT_THINKING_OWNER = Symbol.for("pi.ccstyle.compact-thinking-owner");

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const owner = {};
	const host = globalThis as typeof globalThis & {
		[COMPACT_THINKING_OWNER]?: CompactThinkingOwner;
	};
	host[COMPACT_THINKING_OWNER]?.stop();

	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	// Upstream requires this file while loading; mirror ccstyle into it and never read it back.
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "compact-thinking.json"),
		`${JSON.stringify(initialConfig, null, 2)}\n`,
		"utf8",
	);

	// Reuse Pi's live modules so the upstream prototype patch reaches runtime components.
	const jiti = createJiti(import.meta.url, {
		virtualModules: {
			"@earendil-works/pi-ai": piAi,
			"@earendil-works/pi-coding-agent": piCodingAgent,
			"@earendil-works/pi-tui": piTui,
		},
	});
	const upstreamConfig = (
		jiti("pi-compact-thinking/lib/config.ts") as { config: CompactThinkingConfig }
	).config;
	const compactThinking = (
		jiti("pi-compact-thinking/index.ts") as {
			default: (api: ExtensionAPI) => void;
		}
	).default;
	Object.assign(upstreamConfig, initialConfig);

	let session: { event: any; ctx: any } | undefined;
	let shutdown: ((event: any, ctx: any) => void) | undefined;
	let stopped = false;
	const stop = (event?: any, ctx?: any) => {
		if (stopped) return;
		stopped = true;
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (host[COMPACT_THINKING_OWNER]?.owner === owner) delete host[COMPACT_THINKING_OWNER];
	};
	compactThinking({
		on(event: string, handler: (event: any, ctx: any) => void) {
			if (event === "session_start") {
				pi.on(event, (startEvent, ctx) => {
					session = { event: startEvent, ctx };
					handler(startEvent, ctx);
				});
			} else if (event === "session_shutdown") {
				shutdown = handler;
				pi.on(event, (shutdownEvent, ctx) => {
					if (host[COMPACT_THINKING_OWNER]?.owner === owner) stop(shutdownEvent, ctx);
				});
			} else {
				pi.on(event as any, handler as any);
			}
		},
		appendEntry: (...args: any[]) => (pi.appendEntry as any)(...args),
	} as unknown as ExtensionAPI);
	host[COMPACT_THINKING_OWNER] = { owner, stop };

	return {
		updateConfig(next) {
			Object.assign(upstreamConfig, next);
		},
	};
}
