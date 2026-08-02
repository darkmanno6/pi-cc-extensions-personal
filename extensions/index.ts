import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentAutocomplete from "./agent-autocomplete.ts";
import askUserQuestion from "./ask-user-question/index.ts";
import claudeCodeStyle from "./claude-code-style.ts";
import context from "./context.ts";
import piAliases from "./pi-aliases.ts";
import piStartupHeader from "./pi-startup-header.ts";
import sessionReference from "./session-reference.ts";
import subagentNotification from "./subagent-notification.ts";
import workingMessage from "./working-message.ts";

export default function (pi: ExtensionAPI): void {
	piAliases(pi);
	piStartupHeader(pi);
	claudeCodeStyle(pi);
	subagentNotification(pi);
	workingMessage(pi);
	context(pi);
	sessionReference(pi);
	agentAutocomplete(pi);
	askUserQuestion(pi);
}
