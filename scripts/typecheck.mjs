#!/usr/bin/env node
/**
 * Minimal type-check gate for pi-cc-extensions.
 *
 * Only fails on:
 *   - Parse / syntax errors       (TS1xxx codes)
 *   - Duplicate declarations      (TS2300 Duplicate identifier,
 *                                   TS2393 Duplicate function implementation)
 *   - TS18003 No inputs were found（tsconfig 失效时本脚本会“空检查”通过）
 *   - tsc 未能运行（spawn 失败 / 崩溃且无诊断输出）
 *
 * 其余错误（类型可赋值性等）视为既有问题，忽略。
 * 非诊断行（npm 噪声等）不参与判定；启动失败由“非零退出码 + 无诊断”规则捕获。
 * tsc 走本地固定版本依赖（node_modules/typescript），不经过 npx 下载。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Codes we treat as hard errors.
const FATAL_CODES = new Set([
	2300, // Duplicate identifier
	2393, // Duplicate function implementation
	18003, // No inputs were found in config file（tsconfig 失效 → 空检查）
]);

// 诊断行如 `path(line,col): error TS1234: message`；TS 错误码 4~5 位。
const TS_CODE_RE = /\bTS(\d{4,5})\b/;

const result = spawnSync(
	process.execPath,
	[resolve(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
	{
		cwd: root,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	},
);

const combined = (result.stdout || "") + (result.stderr || "");
const lines = combined.split(/\r?\n/).filter(Boolean);
const hasDiagnostics = lines.some((l) => TS_CODE_RE.test(l));

// tsc 没能跑起来（spawn 失败 / 崩溃且无诊断输出）→ 判失败，避免“空检查通过”
if (result.status === null || (result.status !== 0 && !hasDiagnostics)) {
	console.error("❌ tsc failed to run (spawn error or crash, no diagnostics)");
	process.exit(1);
}

// 单遍分类：非诊断行忽略
const fatalLines = [];
const infoLines = [];
for (const line of lines) {
	const m = line.match(TS_CODE_RE);
	if (!m) continue;
	const code = Number(m[1]);
	if ((code >= 1000 && code <= 1199) || FATAL_CODES.has(code)) fatalLines.push(line);
	else infoLines.push(line);
}

if (infoLines.length > 0) {
	console.error("ℹ️  Pre-existing non-fatal issues (ignored):");
	for (const l of infoLines.slice(0, 10)) console.error(`   ${l}`);
	if (infoLines.length > 10) console.error(`   ... and ${infoLines.length - 10} more`);
}

if (fatalLines.length > 0) {
	console.error("\n❌ FATAL errors (must fix):");
	for (const l of fatalLines) console.error(`   ${l}`);
	process.exit(1);
}

console.log("✅ typecheck passed");
process.exit(0);
