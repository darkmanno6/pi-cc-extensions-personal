import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentAutocomplete from "./feature/agent-autocomplete.ts";
import agentSummary from "./feature/agent-summary.ts";
import claudeCodeStyle, { getCompactThinkingConfig } from "./renderer/index.ts";
import {
	installCompactThinking,
	type CompactThinkingController,
} from "./feature/compact-thinking.ts";
import context from "./feature/context.ts";
import markdownEnhance from "./feature/markdown-enhance.ts";
import piAliases from "./feature/pi-aliases.ts";
import piStartupHeader from "./feature/pi-startup-header.ts";
import sessionReference from "./feature/session-reference.ts";
import workingMessage from "./feature/working-message.ts";

export default function (pi: ExtensionAPI): void {
	piAliases(pi);
	piStartupHeader(pi);
	markdownEnhance(pi);
	let compactThinking: CompactThinkingController | undefined;
	const compactThinkingBridge: CompactThinkingController = {
		updateConfig(next) {
			compactThinking?.updateConfig(next);
		},
		getMessageThinkingDurationMs(messageTimestamp) {
			return compactThinking?.getMessageThinkingDurationMs?.(messageTimestamp);
		},
		isMessageThinkingActive(messageTimestamp) {
			return compactThinking?.isMessageThinkingActive?.(messageTimestamp) ?? false;
		},
		getThinkingAnimationFrame() {
			return compactThinking?.getThinkingAnimationFrame?.() ?? 0;
		},
		setCompactSummaryActive(active) {
			compactThinking?.setCompactSummaryActive?.(active);
		},
	};
	claudeCodeStyle(pi, undefined, compactThinkingBridge);
	compactThinking = installCompactThinking(pi, getCompactThinkingConfig());
	workingMessage(pi);
	context(pi);
	sessionReference(pi);
	agentAutocomplete(pi);
	agentSummary(pi);
}
