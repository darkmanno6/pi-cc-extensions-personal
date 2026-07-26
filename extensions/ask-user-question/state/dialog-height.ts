const FULL_HEIGHT_BREAKPOINT = 16;
const MIN_DIALOG_ROWS = 10;
const MIN_HISTORY_ROWS = 6;
const HISTORY_RATIO = 0.3;

/**
 * Keep recent transcript rows visible above the temporary questionnaire editor.
 * Very small terminals fall back to full height so the dialog remains usable.
 */
export function getDialogMaxRows(terminalRows: number): number {
	const rows = Math.max(1, Math.floor(terminalRows));
	if (rows < FULL_HEIGHT_BREAKPOINT) return rows;

	const historyRows = Math.max(MIN_HISTORY_ROWS, Math.floor(rows * HISTORY_RATIO));
	return Math.min(rows, Math.max(MIN_DIALOG_ROWS, rows - historyRows));
}
