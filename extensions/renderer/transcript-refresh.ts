import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

// pi-coding-agent 类型声明中 AssistantMessageComponent 仅能以 value 形式使用，
// updateContent/lastMessage 用结构化类型访问。
type TranscriptComponentInternals = {
	lastMessage?: AssistantMessage;
	updateContent(message: AssistantMessage): void;
	invalidate?(): void;
};

/**
 * 重绘单个已构造的组件：assistant 用最新消息重渲染（compact thinking），
 * tool 强制 updateDisplay（其内容可能仍在旧 shell 容器中）。
 * 不吞异常——由调用方决定如何处理失败。
 */
export function refreshTranscriptComponent(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (value instanceof AssistantMessageComponent) {
		const self = value as unknown as TranscriptComponentInternals;
		if (self.lastMessage) self.updateContent(self.lastMessage);
		else self.invalidate?.();
		return true;
	}
	if (value instanceof ToolExecutionComponent) {
		// updateDisplay 是私有方法，但它是 resume 后让内容回到正确
		// shell 容器的唯一入口（原型链已含全局工具渲染补丁）。
		(value as unknown as { updateDisplay(): void }).updateDisplay();
		return true;
	}
	return false;
}

/**
 * 扫描挂载树，重绘所有已构造的 assistant/tool 组件。
 * 用于 reload/resume/compaction 后"pi 用原始原型重建、补丁事后才装"的场景。
 * 遍历 value.children 与 value.getMountedRoots?.()（seen 集合防环），
 * 单个组件失败用 try/catch 隔离，不影响其余组件。
 */
// compact-mode 把补丁暴露在此 Symbol 上（见 compact-mode.ts），避免循环依赖。
const COMPACT_MODE_PATCH_KEY = Symbol.for("pi.ccstyle.compact-mode-patch");

/**
 * 补丁链序不变量：compact 模式下 compact-mode 必须位于 compact-thinking
 * 外层（round 摘要才能聚合工具统计）。resume/reload 后若无新消息，
 * message_update 触发的重新认领不会执行，这里在任何重绘前先断言一次。
 * 断言幂等：链序已正确时无操作；mode=on 时也安全（外层走 pass-through）。
 */
function assertCompactModeOutermost(): void {
	try {
		const patch = (globalThis as any)[COMPACT_MODE_PATCH_KEY];
		if (typeof patch?.assertAssistantOwnership === "function") {
			patch.assertAssistantOwnership();
		}
	} catch {
		// 无 compact-mode 补丁或断言失败时跳过，扫描仍会执行。
	}
}

export function refreshMountedTranscript(tui?: unknown): void {
	if (!tui || typeof (tui as any).getMountedRoots !== "function") return;
	// 先修正链序再重绘：扫描触发 updateContent 时 compact-mode 已在外层。
	assertCompactModeOutermost();
	const seen = new Set<object>();
	const visit = (value: any): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child);
			return;
		}
		try {
			refreshTranscriptComponent(value);
		} catch {
			// 单个组件失败不阻断其余组件；后续 session_tree/重绘再试。
		}
		const children = value.children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
		try {
			const mounted = value.getMountedRoots?.();
			if (Array.isArray(mounted)) {
				for (const root of mounted) visit(root);
			}
		} catch {
			// 惰性 Proxy / 未挂载容器没有 mounted roots。
		}
	};
	visit(tui);
}
