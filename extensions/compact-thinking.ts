import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = join(agentDir, "compact-thinking.json");
	let hasValidCompatibilityConfig = false;
	try {
		const value = JSON.parse(readFileSync(configPath, "utf8")) as Partial<CompactThinkingConfig>;
		hasValidCompatibilityConfig =
			typeof value.useSummaryTitlesAsThinkingTitle === "boolean" &&
			Number.isInteger(value.previewLines) &&
			(value.previewLines ?? -1) >= 0 &&
			Number.isFinite(value.animationIntervalMs) &&
			(value.animationIntervalMs ?? 0) >= 1;
	} catch {
		// The upstream loader needs a valid compatibility file on first install.
	}
	if (!hasValidCompatibilityConfig) {
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
	}

	// The package publishes TypeScript source only, so use the loader already used by fixed-editor.
	const jiti = createJiti(import.meta.url);
	const upstreamConfig = (
		jiti("pi-compact-thinking/lib/config.ts") as { config: CompactThinkingConfig }
	).config;
	const compactThinking = (
		jiti("pi-compact-thinking/index.ts") as {
			default: (api: ExtensionAPI) => void;
		}
	).default;
	Object.assign(upstreamConfig, initialConfig);
	compactThinking(pi);

	return {
		updateConfig(next) {
			Object.assign(upstreamConfig, next);
		},
	};
}
