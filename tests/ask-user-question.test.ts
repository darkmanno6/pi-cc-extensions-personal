import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { getDialogMaxRows } from "../extensions/ask-user-question/state/dialog-height.ts";

test("questionnaire height preserves transcript space on normal terminals", () => {
	assert.equal(getDialogMaxRows(15), 15, "small terminals use full height");
	assert.equal(getDialogMaxRows(16), 10, "the breakpoint keeps six transcript rows");
	assert.equal(getDialogMaxRows(24), 17, "normal terminals reserve about 30% for transcript history");
	assert.equal(getDialogMaxRows(40), 28);
});

test("questionnaire uses the host's temporary editor flow in scrolling and fixed layouts", () => {
	const source = readFileSync(new URL("../extensions/ask-user-question/ask-user-question.ts", import.meta.url), "utf8");
	assert.match(source, /ctx\.ui\.custom<QuestionnaireResult>\(\(tui, theme, _kb, done\) =>/);
	assert.doesNotMatch(source, /overlay:\s*true/);
	assert.doesNotMatch(source, /onTerminalInput/);
	assert.doesNotMatch(source, /(?:set|get)EditorComponent/);
});

test("questionnaire is English-only without localization assets", () => {
	const entry = readFileSync(new URL("../extensions/ask-user-question/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(entry, /rpiv-i18n|registerLocalesFromDir|I18N_NAMESPACE/);
	assert.equal(existsSync(new URL("../extensions/ask-user-question/state/i18n-bridge.ts", import.meta.url)), false);
	assert.equal(existsSync(new URL("../extensions/ask-user-question/locales", import.meta.url)), false);
	assert.equal(existsSync(new URL("../extensions/ask-user-question/docs", import.meta.url)), false);
});
