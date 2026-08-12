#!/usr/bin/env node
/**
 * Minimal type-check gate for pi-cc-extensions.
 *
 * Fails on:
 *   - Any tsc diagnostic（语法错误、重复声明、类型可赋值性错误等，一律拦截）
 *   - TS18003 No inputs were found（tsconfig 失效时本脚本会“空检查”通过）
 *   - tsc 未能运行（spawn 失败 / 崩溃且无诊断输出）
 *
 * 非诊断行（npm 噪声等）不参与判定；启动失败由“非零退出码 + 无诊断”规则捕获。
 * tsc 走本地固定版本依赖（node_modules/typescript），不经过 npx 下载。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

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

// 单遍收集：任何 TS 诊断都视为错误，不再区分致命/非致命。
const errorLines = lines.filter((l) => TS_CODE_RE.test(l));

if (errorLines.length > 0) {
	console.error("❌ Type errors (must fix):");
	for (const l of errorLines.slice(0, 20)) console.error(`   ${l}`);
	if (errorLines.length > 20) console.error(`   ... and ${errorLines.length - 20} more`);
	process.exit(1);
}

console.log("✅ typecheck passed");
process.exit(0);
