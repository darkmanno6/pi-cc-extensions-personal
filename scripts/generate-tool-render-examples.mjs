#!/usr/bin/env node
/**
 * 用真实 ccstyle renderer 生成 docs/tool-render-examples.md。
 * 用法：npm run docs:tool-render
 *
 * 通过 child_process 以 --experimental-strip-types 跑 TS 入口，
 * 保证与测试同一模块图（ToolExecutionComponent instanceof 才能分组）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const entry = join(root, "scripts/generate-tool-render-examples.ts");

const result = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

process.exit(result.status ?? 1);
