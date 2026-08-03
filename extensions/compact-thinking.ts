import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

	// Fork the upstream entry so a running subagent tool keeps the thinking
	// loading animation until the model emits the next text/thinking boundary.
	// Upstream finalizes on tool_execution_start, freezing the summary into a
	// static "Thought for Xs" for the whole subagent run.
	const upstreamRequire = createRequire(import.meta.url);
	const upstreamIndexPath = upstreamRequire.resolve("pi-compact-thinking/index.ts");
	const toolStartOriginal = `  pi.on("tool_execution_start", finishThinking);`;
	const toolStartPatched = `  // Subagent tools can run for minutes: keep the thinking loading animation
  // alive for the whole execution and only finalize once the model emits the
  // next text/thinking boundary or the message ends.
  function resumeAgentThinking(message: AssistantMessage | undefined) {
    if (activeThinking) return;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    const index = content.findIndex((item) => item?.type === "thinking");
    if (index < 0) return;
    startThinking(message, index);
  }
  pi.on("tool_execution_start", (event: any) => {
    if (event.toolName === "Agent" || event.toolName === "Agents") {
      resumeAgentThinking(latestComponent?.lastMessage ?? undefined);
    } else {
      finishThinking();
    }
  });`;
	const updateBoundaryOriginal = `    } else if (
      update.type === "text_start" ||
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      finishThinking();
    }`;
	const updateBoundaryPatched = `    } else if (update.type === "text_start") {
      finishThinking();
    } else if (
      update.type === "toolcall_start" ||
      update.type === "toolcall_delta"
    ) {
      if (
        Array.isArray(event.message?.content) &&
        event.message.content.some(
          (content) =>
            content?.type === "toolCall" &&
            (content.name === "Agent" ||
              content.name === "Agents" ||
              content.args?.subagent_type != null),
        )
      ) {
        resumeAgentThinking(event.message);
      } else {
        finishThinking();
      }
    }`;
	let upstreamIndexSource = readFileSync(upstreamIndexPath, "utf8");
	if (
		upstreamIndexSource.includes(toolStartOriginal) &&
		upstreamIndexSource.includes(updateBoundaryOriginal)
	) {
		upstreamIndexSource = upstreamIndexSource
			.replace(toolStartOriginal, toolStartPatched)
			.replace(updateBoundaryOriginal, updateBoundaryPatched);
	} else {
		// Upstream changed shape: fall back to the untouched entry so the loader
		// keeps working; only the subagent animation nicety is lost.
		upstreamIndexSource = readFileSync(upstreamIndexPath, "utf8");
	}

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
		jiti.evalModule(upstreamIndexSource, { filename: upstreamIndexPath }) as {
			default: (api: ExtensionAPI) => void;
		}
	).default;
	Object.assign(upstreamConfig, initialConfig);

	// Upstream restores completedDurations from sessionManager.getBranch() (the
	// current leaf path). After compaction or a branch switch, duration entries
	// of older messages leave that path, so scrolling back renders a bare
	// "Thinking..." instead of "Thought for Xs". Restore from every entry.
	const restoreAllDurations = (ctx: any): any => {
		const sessionManager = ctx?.sessionManager;
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return ctx;
		return {
			...ctx,
			sessionManager: {
				...sessionManager,
				getBranch: () => sessionManager.getEntries(),
			},
		};
	};

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
					handler(startEvent, restoreAllDurations(ctx));
				});
			} else if (event === "session_shutdown") {
				shutdown = handler;
				pi.on(event, (shutdownEvent, ctx) => {
					if (host[COMPACT_THINKING_OWNER]?.owner === owner) stop(shutdownEvent, ctx);
				});
			} else {
				pi.on(event as any, (e: any, ctx: any) =>
					handler(e, event === "session_tree" ? restoreAllDurations(ctx) : ctx),
				);
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
