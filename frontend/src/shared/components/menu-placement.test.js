import { describe, expect, test } from "bun:test";
import { menuPlacement, menuPlacementStyle } from "./menu-placement.js";

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

// Measured in the audit baseline: the desktop rail is 76px wide and its Help and
// Workspace commands sit near the bottom; the old fixed "below, right-aligned"
// placement put the menus at x = -143 and past the bottom edge.
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const HELP_MENU = { width: 208, height: 202 };
const WORKSPACE_MENU = { width: 208, height: 411 };

function boxFor(trigger, menu, placement) {
	const { side, align } = placement;
	if (side === "bottom" || side === "top") {
		const top = side === "bottom" ? trigger.bottom + 4 : trigger.top - 4 - menu.height;
		const left = align === "end" ? trigger.right - menu.width : trigger.left;
		return { left, top, right: left + menu.width, bottom: top + Math.min(menu.height, placement.maxHeight) };
	}
	const left = side === "right" ? trigger.right + 8 : trigger.left - 8 - menu.width;
	const height = Math.min(menu.height, placement.maxHeight);
	const top = align === "start" ? trigger.top : trigger.bottom - height;
	return { left, top, right: left + menu.width, bottom: top + height };
}

function expectInside(box, viewport) {
	expect(box.left).toBeGreaterThanOrEqual(0);
	expect(box.top).toBeGreaterThanOrEqual(0);
	expect(box.right).toBeLessThanOrEqual(viewport.width);
	expect(box.bottom).toBeLessThanOrEqual(viewport.height);
}

describe("menuPlacement", () => {
	test("rail menus on desktop open beside the rail and stay on screen", () => {
		const help = rect(10, 784, 55, 48);
		const helpPlacement = menuPlacement(help, HELP_MENU, DESKTOP, "right");
		expect(helpPlacement.side).toBe("right");
		expect(helpPlacement.align).toBe("end");
		expectInside(boxFor(help, HELP_MENU, helpPlacement), DESKTOP);

		const workspace = rect(10, 596, 55, 48);
		const workspacePlacement = menuPlacement(workspace, WORKSPACE_MENU, DESKTOP, "right");
		expect(workspacePlacement.side).toBe("right");
		expectInside(boxFor(workspace, WORKSPACE_MENU, workspacePlacement), DESKTOP);
	});

	test("the same rail menus drop down inside the phone command bar", () => {
		const workspace = rect(158, 9, 40, 40);
		const placement = menuPlacement(workspace, WORKSPACE_MENU, PHONE, "right");
		expect(placement).toMatchObject({ side: "bottom", align: "start" });
		expectInside(boxFor(workspace, WORKSPACE_MENU, placement), PHONE);

		const help = rect(284, 9, 40, 40);
		const helpPlacement = menuPlacement(help, HELP_MENU, PHONE, "right");
		expect(helpPlacement).toMatchObject({ side: "bottom", align: "end" });
		expectInside(boxFor(help, HELP_MENU, helpPlacement), PHONE);
	});

	test("a row menu near the bottom of the viewport flips above its trigger", () => {
		const trigger = rect(300, 820, 30, 30);
		const placement = menuPlacement(trigger, { width: 208, height: 300 }, DESKTOP);
		expect(placement).toMatchObject({ side: "top", align: "end" });
		expectInside(boxFor(trigger, { width: 208, height: 300 }, placement), DESKTOP);
	});

	test("default menus keep the original below, end-aligned placement when it fits", () => {
		expect(menuPlacement(rect(300, 200, 30, 30), HELP_MENU, DESKTOP)).toMatchObject({ side: "bottom", align: "end" });
	});

	test("a menu taller than the available room is capped so it scrolls", () => {
		const placement = menuPlacement(rect(300, 100, 30, 30), { width: 208, height: 2000 }, DESKTOP);
		expect(placement.maxHeight).toBeLessThanOrEqual(DESKTOP.height - 130);
		expect(menuPlacementStyle(placement).maxHeight).toBe(`${placement.maxHeight}px`);
	});

	test("before measurement the menu renders hidden so it never flashes off-screen", () => {
		expect(menuPlacementStyle(null).visibility).toBe("hidden");
		expect(menuPlacementStyle({ side: "right", align: "end", maxHeight: 400 })).toMatchObject({ left: "calc(100% + 8px)", bottom: 0 });
	});
});
