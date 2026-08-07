import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentAutocomplete from "./agent-autocomplete.ts";
import claudeCodeStyle, { getCompactThinkingConfig } from "./claude-code-style.ts";
import { installCompactThinking, type CompactThinkingController } from "./compact-thinking.ts";
import context from "./context.ts";
import markdownEnhance from "./markdown-enhance.ts";
import piAliases from "./pi-aliases.ts";
import piStartupHeader from "./pi-startup-header.ts";
import sessionReference from "./session-reference.ts";
import workingMessage from "./working-message.ts";

export default function (pi: ExtensionAPI): void {
	piAliases(pi);
	piStartupHeader(pi);
	markdownEnhance(pi);
	let compactThinking: CompactThinkingController | undefined;
	const compactThinkingBridge: CompactThinkingController = {
		updateConfig(next) {
			compactThinking?.updateConfig(next);
		},
	};
	claudeCodeStyle(pi, undefined, compactThinkingBridge);
	compactThinking = installCompactThinking(pi, getCompactThinkingConfig());
	workingMessage(pi);
	context(pi);
	sessionReference(pi);
	agentAutocomplete(pi);
}
