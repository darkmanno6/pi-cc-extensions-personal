import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	initTheme,
	SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	installMessageDisplayRendering,
	refreshMessageDisplays,
	setMessageDisplayTheme,
} from "../extensions/renderer/message-display.ts";
import { config, DEFAULT_CONFIG, setConfig, normalizeConfig } from "../extensions/config/config.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

initTheme("dark");

function fakeTheme() {
	return { fg: (_color: string, text: string) => text };
}

function makeSkillBlock(name = "ponytail", content = "**lazy** content\n\n- rule 1") {
	return new SkillInvocationMessageComponent(
		{ name, content, userMessage: null },
		getMarkdownTheme(),
	);
}

function makeCompaction(summary = "summarized history", tokensBefore = 12345) {
	return new CompactionSummaryMessageComponent(
		{ summary, tokensBefore },
		getMarkdownTheme(),
	);
}

function makeBranch(summary = "branch work") {
	return new BranchSummaryMessageComponent({ summary }, getMarkdownTheme());
}

test("message-display: ccstyle on 时三个组件渲染为工具调用风格", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());

	// skill 块：collapsed ● Skill <name>，无原生 [skill] 标签
	const skill = makeSkillBlock();
	const skillCollapsed = stripAnsi(skill.render(120).join("\n"));
	assert.match(skillCollapsed, /✓ Skill ponytail/);
	assert.doesNotMatch(skillCollapsed, /\[skill\]/);
	// expanded：标题行 + markdown 正文
	skill.setExpanded(true);
	const skillExpanded = stripAnsi(skill.render(120).join("\n"));
	assert.match(skillExpanded, /✓ Skill ponytail/);
	assert.match(skillExpanded, /lazy/);

	// 压缩摘要：collapsed ● Compacted from N tokens
	const compaction = makeCompaction();
	const compactionCollapsed = stripAnsi(compaction.render(120).join("\n"));
	assert.match(compactionCollapsed, /✓ Compacted from 12,345 tokens/);
	assert.doesNotMatch(compactionCollapsed, /\[compaction\]/);
	compaction.setExpanded(true);
	const compactionExpanded = stripAnsi(compaction.render(120).join("\n"));
	assert.match(compactionExpanded, /summarized history/);

	// 分支摘要：collapsed ● Branch summary
	const branch = makeBranch();
	const branchCollapsed = stripAnsi(branch.render(120).join("\n"));
	assert.match(branchCollapsed, /✓ Branch summary/);
	assert.doesNotMatch(branchCollapsed, /\[branch\]/);
	branch.setExpanded(true);
	assert.match(stripAnsi(branch.render(120).join("\n")), /branch work/);

	dispose();
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
});

test("message-display: mode off 或 dispose 后回退原生渲染", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());
	const skill = makeSkillBlock();
	const compaction = makeCompaction();
	assert.doesNotMatch(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.doesNotMatch(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);

	// mode=off：恢复原生标签
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
	skill.invalidate();
	compaction.invalidate();
	assert.match(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.match(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);

	// dispose 后同样回退
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	skill.invalidate();
	compaction.invalidate();
	assert.doesNotMatch(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	dispose();
	skill.invalidate();
	compaction.invalidate();
	assert.match(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.match(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);
});

test("message-display: refreshMessageDisplays 遍历并刷新已挂载组件", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());
	const components = [makeSkillBlock(), makeCompaction(), makeBranch()];
	let invalidated = 0;
	for (const component of components) {
		component.invalidate = () => {
			invalidated++;
			component.updateDisplay();
		};
	}
	const root = {
		children: [{ children: components }],
		getMountedRoots: () => [],
	};
	refreshMessageDisplays(root);
	assert.equal(invalidated, 3);
	dispose();
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
});
