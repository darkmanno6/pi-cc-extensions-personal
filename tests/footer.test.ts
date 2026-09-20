import assert from "node:assert/strict";
import test from "node:test";
import {
	config,
	formatConfigStatus,
	normalizeConfig,
	setConfig,
} from "../extensions/config/config.ts";
import {
	applyCustomFooter,
	classifyStatus,
	clearCustomFooter,
	formatXaiFooterChip,
	parseGitStats,
	pickFooterUsageText,
} from "../extensions/feature/shell/footer.ts";

test("normalizeConfig defaults enableCustomFooter on and honors explicit off", () => {
	assert.equal(normalizeConfig({}).enableCustomFooter, true);
	assert.equal(normalizeConfig({ enableCustomFooter: false }).enableCustomFooter, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /footer=on/);
	assert.match(formatConfigStatus(normalizeConfig({ enableCustomFooter: false })), /footer=off/);
});

test("disabled custom footer leaves another extension's footer untouched", () => {
	const previous = { ...config };
	const calls: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setFooter: (factory: unknown) => calls.push(factory),
		},
	};

	try {
		setConfig(normalizeConfig({ enableCustomFooter: false }));
		applyCustomFooter(ctx as never);
		assert.deepEqual(calls, []);

		clearCustomFooter(ctx as never);
		assert.deepEqual(calls, [undefined]);
	} finally {
		setConfig(previous);
	}
});

test("classifyStatus skips model, buckets usage-like keys, keeps other statuses", () => {
	assert.equal(classifyStatus("model"), "skip");
	assert.equal(classifyStatus("usage"), "usage");
	assert.equal(classifyStatus("pi-grok-usage"), "usage");
	assert.equal(classifyStatus("cloud-quota"), "usage");
	assert.equal(classifyStatus("ponytail"), "other");
});

test("formatXaiFooterChip prefers included percent then prepaid dollars", () => {
	assert.equal(
		formatXaiFooterChip({
			buckets: [{ id: "included-allowance", unit: "percent", used: 14.4 }],
		}),
		"xAI 14%",
	);
	assert.equal(
		formatXaiFooterChip({
			metrics: [{ id: "prepaid-balance", value: 1.5 }],
		}),
		"xAI $1.50",
	);
});

test("pickFooterUsageText prefers plugin text and falls back while checking", () => {
	assert.equal(pickFooterUsageText("checking", "xAI 14%"), "xAI 14%");
	assert.equal(pickFooterUsageText("codex 5%", "xAI 14%"), "codex 5%");
});

test("parseGitStats sums numstat add/delete columns", () => {
	assert.deepEqual(parseGitStats("10\t2\ta.ts\n3\t1\tb.ts\n"), { add: 13, del: 3 });
	assert.deepEqual(parseGitStats(""), { add: 0, del: 0 });
});
