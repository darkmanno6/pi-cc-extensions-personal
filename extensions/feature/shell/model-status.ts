import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function modelLabel(model: any): string | undefined {
	if (!model) return undefined;
	const name = model.name || model.id;
	if (!name) return undefined;
	return model.provider ? `${model.provider} · ${name}` : name;
}

function apply(ctx: any): void {
	if (!ctx?.hasUI) return;
	ctx.ui?.setStatus?.("model", modelLabel(ctx.model));
}

/** 用 setStatus 挂模型名，不 setFooter，不接管原生 footer。 */
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => apply(ctx));
	pi.on("model_select", async (_event, ctx) => apply(ctx));
}
