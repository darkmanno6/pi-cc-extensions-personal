import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type DialogBounds = { left: number; top: number; width: number };

export function renderDialogTopBorder(width: number, color: (text: string) => string): string {
	const safeWidth = Math.max(4, Math.floor(width));
	return color(`╭${"─".repeat(safeWidth - 2)}╮`);
}

/** Render title and a larger [ × ] target on the row below the top border. */
export function renderDialogHeader(
	title: string,
	width: number,
	color: (text: string) => string,
	titleColor: (text: string) => string,
	closeColor: (text: string) => string,
): string {
	const safeWidth = Math.max(8, Math.floor(width));
	const innerWidth = safeWidth - 2;
	const button = "[ × ]";
	const titleWidth = Math.max(0, innerWidth - visibleWidth(button) - 2);
	const shownTitle = truncateToWidth(title, titleWidth, "…");
	const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(shownTitle) - visibleWidth(button)));
	return `${color("│")}${titleColor(shownTitle)}${gap}${closeColor(button)}${color("│")}`;
}

/** Match a left-button press anywhere on the [ × ] target. */
export function isDialogCloseClick(data: string, bounds: DialogBounds): boolean {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match || match[4] !== "M") return false;
	const code = Number(match[1]);
	if ((code & 3) !== 0 || (code & 32) !== 0) return false;
	const col = Number(match[2]);
	const firstButtonCol = bounds.left + bounds.width - 7;
	const lastButtonCol = bounds.left + bounds.width - 3;
	return col >= firstButtonCol && col <= lastButtonCol && Number(match[3]) === bounds.top + 1;
}

export function centeredDialogBounds(
	terminal: { columns: number; rows: number },
	width: number,
	height: number,
): DialogBounds {
	return {
		left: Math.floor((terminal.columns - width) / 2) + 1,
		top: Math.floor((terminal.rows - height) / 2) + 1,
		width,
	};
}

export function bottomDialogBounds(
	terminal: { rows: number },
	width: number,
	height: number,
): DialogBounds {
	return { left: 1, top: Math.max(1, terminal.rows - height + 1), width };
}
