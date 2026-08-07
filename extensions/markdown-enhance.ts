import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid, sourceBox } from "grok-mermaid";

// ============================================================================
// Mermaid 方言渲染
// ============================================================================

// 内置 mermaid transformer 只认 ```mermaid，这里补上 grok-mermaid 支持的其他方言
const DIAGRAM_FENCE = /^(`{3,})\s*(mermaid|statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** 把一行图内容包成行内代码（保持空格与框线字符对齐）。 */
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** 渲染失败或图宽超出终端宽度时，把源码包进带标题的框里显示。 */
function framedSource(src: string, width: number): string {
	const box = sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** 解析 ```diagram 代码块，返回 { 源码, 块内行数 }；未闭合返回 null。 */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	let j = i + 1;
	while (j < lines.length) {
		if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]);
		j++;
	}
	return null; // 未闭合：放弃转换，保持原文
}

// ============================================================================
// GitHub 风格提示框（admonition）
// ============================================================================

const ADMONITION = /^>\s*\[\s*!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\s*\]\s*(.*)$/i;
const ADMONITION_STYLE: Record<string, { icon: string; label: string }> = {
	NOTE: { icon: "💡", label: "NOTE" },
	TIP: { icon: "✅", label: "TIP" },
	IMPORTANT: { icon: "❗", label: "IMPORTANT" },
	WARNING: { icon: "⚠️", label: "WARNING" },
	CAUTION: { icon: "⚠️", label: "CAUTION" },
};

/**
 * 把 > [!TYPE] 及其后续 > 行转成两列表格（图标标签列 + 内容列），视觉上成提示框。
 * 表格 cell 内不支持换行（<br> 显示为字面量），多行内容用空格合并。
 * 返回 null 表示该行不是提示框。
 */
function renderAdmonition(lines: string[], i: number): { output: string[]; next: number } | null {
	const m = lines[i].match(ADMONITION);
	if (!m) return null;
	const style = ADMONITION_STYLE[m[1].toUpperCase()];
	const body: string[] = [m[2]];
	let j = i + 1;
	while (j < lines.length && /^>\s?/.test(lines[j]) && !ADMONITION.test(lines[j])) {
		body.push(lines[j].replace(/^>\s?/, ""));
		j++;
	}
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
	// 内容里的 | 转义，避免拆出额外表格列
	const content = body.join(" ").trim().replace(/\|/g, "\\|");
	// 表格后补空行，防止紧接的段落被解析为表格数据行
	return {
		output: [`| ${style.icon} ${style.label} | ${content} |`, "|---|---|", ""],
		next: j,
	};
}

// ============================================================================
// 裸 URL 转可点击超链接
// ============================================================================

const URL_RE = /(?<!<)(?<!\]\()https?:\/\/[^\s<>'"|，。；：！？、」』】]+/g;
const TRIM_URL_RE = /[.,;:!?】」』"'》]+$/;

/** 去掉 URL 尾部标点；括号按平衡保留（如 Wikipedia 链接含括号）。 */
function trimUrl(url: string): string {
	let t = url.replace(TRIM_URL_RE, "");
	while (t.endsWith(")") && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) {
		t = t.slice(0, -1);
	}
	return t;
}

/**
 * 把代码块和行内代码外的裸 URL 转成 markdown 链接。
 * 已有的 [text](url) / ![alt](url) / <url> 自动链接用 lookbehind 排除。
 */
function linkifyUrls(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^```/.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}
		// 行内代码（`...`）按反引号分片，只处理偶数片（代码外）
		const parts = line.split("`");
		for (let p = 0; p < parts.length; p++) {
			if (p % 2 === 0) {
				parts[p] = parts[p].replace(URL_RE, (url) => {
					const trimmed = trimUrl(url);
					if (trimmed.length === 0) return url;
					return `[${trimmed}](${trimmed})`;
				});
			}
		}
		out.push(parts.join("`"));
	}
	return out.join("\n");
}

// ============================================================================
// 注册
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// 1. Mermaid 方言渲染（流式跳过，最终渲染时执行）
	pi.registerMarkdownTransformer((markdown, context) => {
		const { isStreaming = false, availableWidth } = context ?? {};
		if (isStreaming) return markdown;
		const lines = markdown.split("\n");
		const out: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const fence = line.match(DIAGRAM_FENCE);
			if (fence) {
				const collected = collectFence(lines, i);
				if (collected) {
					const { diagram, next } = collected;
					// grok-mermaid 需要源码自带类型头，方言头在 fence 标签里时补回去
					const label = fence[2];
					const src = label.toLowerCase() === "mermaid" ? diagram : `${label}\n${diagram}`;
					let art = null;
					try {
						art = renderMermaid(src);
					} catch {
						art = null;
					}
					const width = availableWidth ?? 80;
					if (art && art.width <= width) {
						// 图行用硬换行（行尾两空格）连接，防止 Markdown 软换行合并行
						out.push(art.plain.map(codeSpan).join("  \n"));
					} else {
						out.push(framedSource(src, width));
					}
					i = next;
					continue;
				}
				// 未闭合：保持原文
			}
			out.push(line);
			i++;
		}
		return out.join("\n");
	});

	// 2. GitHub 风格提示框（跳过代码块）
	pi.registerMarkdownTransformer((markdown) => {
		const lines = markdown.split("\n");
		const out: string[] = [];
		let inFence = false;
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (/^```/.test(line)) {
				inFence = !inFence;
				out.push(line);
				i++;
				continue;
			}
			if (!inFence && /^>\s*\[\s*!/i.test(line)) {
				const result = renderAdmonition(lines, i);
				if (result) {
					out.push(...result.output);
					i = result.next;
					continue;
				}
			}
			out.push(line);
			i++;
		}
		return out.join("\n");
	});

	// 3. 裸 URL 转超链接
	pi.registerMarkdownTransformer((markdown) => linkifyUrls(markdown));
}
