import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentAutocomplete from "./agent-autocomplete.ts";
import claudeCodeStyle, { getCompactThinkingConfig } from "./claude-code-style.ts";
import { installCompactThinking, type CompactThinkingController } from "./compact-thinking.ts";
import context from "./context.ts";
import piAliases from "./pi-aliases.ts";
import piStartupHeader from "./pi-startup-header.ts";
import sessionReference from "./session-reference.ts";
import subagentNotification from "./subagent-notification.ts";
import workingMessage from "./working-message.ts";

export default function (pi: ExtensionAPI): void {
	piAliases(pi);
	piStartupHeader(pi);
	let compactThinking: CompactThinkingController | undefined;
	const compactThinkingBridge: CompactThinkingController = {
		updateConfig(next) {
			compactThinking?.updateConfig(next);
		},
	};
	claudeCodeStyle(pi, undefined, compactThinkingBridge);
	compactThinking = installCompactThinking(pi, getCompactThinkingConfig());
	subagentNotification(pi);
	workingMessage(pi);
	context(pi);
	sessionReference(pi);
	agentAutocomplete(pi);
}
