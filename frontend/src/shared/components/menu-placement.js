// Chooses where a popup menu opens relative to its trigger so the whole menu
// stays inside the viewport. Menus open below and end-aligned by default; a
// trigger in the vertical command rail prefers to open beside it. Pure so the
// collision rules are regression-testable without a browser.

export const MENU_GAP = 4;
export const MENU_SIDE_GAP = 8;
export const VIEWPORT_MARGIN = 8;

function verticalPlacement(trigger, menu, viewport) {
	const below = viewport.height - VIEWPORT_MARGIN - (trigger.bottom + MENU_GAP);
	const above = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
	const side = menu.height <= below || below >= above ? "bottom" : "top";
	const fitsEnd = trigger.right - menu.width >= VIEWPORT_MARGIN;
	const fitsStart = trigger.left + menu.width <= viewport.width - VIEWPORT_MARGIN;
	return {
		side,
		align: fitsEnd || !fitsStart ? "end" : "start",
		fits: fitsEnd || fitsStart,
		maxHeight: Math.max(0, Math.floor(side === "bottom" ? below : above)),
	};
}

function besidePlacement(trigger, menu, viewport) {
	const right = viewport.width - VIEWPORT_MARGIN - (trigger.right + MENU_SIDE_GAP);
	const left = trigger.left - MENU_SIDE_GAP - VIEWPORT_MARGIN;
	const side = menu.width <= right || right >= left ? "right" : "left";
	const downward = viewport.height - VIEWPORT_MARGIN - trigger.top;
	const upward = trigger.bottom - VIEWPORT_MARGIN;
	const align = menu.height <= downward || downward >= upward ? "start" : "end";
	return {
		side,
		align,
		fits: menu.width <= (side === "right" ? right : left),
		maxHeight: Math.max(0, Math.floor(align === "start" ? downward : upward)),
	};
}

export function menuPlacement(trigger, menu, viewport, preferredSide = "bottom") {
	if (preferredSide === "right") {
		const beside = besidePlacement(trigger, menu, viewport);
		if (beside.fits && beside.side === "right") return strip(beside);
	}
	const vertical = verticalPlacement(trigger, menu, viewport);
	if (vertical.fits) return strip(vertical);
	const beside = besidePlacement(trigger, menu, viewport);
	return strip(beside.fits ? beside : vertical);
}

function strip({ side, align, maxHeight }) {
	return { side, align, maxHeight };
}

export function menuPlacementStyle(placement) {
	if (!placement) return { top: `calc(100% + ${MENU_GAP}px)`, right: 0, visibility: "hidden" };
	const { side, align, maxHeight } = placement;
	const style = { maxHeight: `${maxHeight}px` };
	if (side === "bottom" || side === "top") {
		style[side === "bottom" ? "top" : "bottom"] = `calc(100% + ${MENU_GAP}px)`;
		style[align === "end" ? "right" : "left"] = 0;
	} else {
		style[side === "right" ? "left" : "right"] = `calc(100% + ${MENU_SIDE_GAP}px)`;
		style[align === "start" ? "top" : "bottom"] = 0;
	}
	return style;
}
