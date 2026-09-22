import { describe, expect, test } from "bun:test";
import { dialogStackSize, handleEscapeKey, isTopDialog, popDialog, pushDialog } from "./dialog-stack.js";

const fakeEvent = () => {
	const event = { key: "Escape", prevented: false };
	event.preventDefault = () => {
		event.prevented = true;
	};
	return event;
};

describe("dialog stack", () => {
	test("only the last opened dialog is on top", () => {
		const runner = {};
		const recorder = {};
		pushDialog(runner);
		pushDialog(recorder);
		expect(isTopDialog(recorder)).toBe(true);
		expect(isTopDialog(runner)).toBe(false);
		popDialog(recorder);
		expect(isTopDialog(runner)).toBe(true);
		popDialog(runner);
		expect(dialogStackSize()).toBe(0);
		expect(isTopDialog(runner)).toBe(false);
	});

	test("popping an unknown or repeated token is safe", () => {
		const first = {};
		const second = {};
		pushDialog(first);
		pushDialog(second);
		popDialog({});
		popDialog(first);
		popDialog(first);
		expect(isTopDialog(second)).toBe(true);
		popDialog(second);
		expect(dialogStackSize()).toBe(0);
	});

	test("one Escape closes exactly the top dialog", () => {
		const closed = [];
		const runner = { onClose: () => closed.push("runner") };
		const recorder = { onClose: () => closed.push("recorder") };
		pushDialog(runner);
		pushDialog(recorder);

		const event = fakeEvent();
		handleEscapeKey(event);
		expect(closed).toEqual(["recorder"]);
		expect(event.prevented).toBe(true);
		expect(dialogStackSize()).toBe(2);

		popDialog(recorder);
		handleEscapeKey(fakeEvent());
		expect(closed).toEqual(["recorder", "runner"]);
		popDialog(runner);
	});

	test("Escape without an open dialog and non-Escape keys do nothing", () => {
		const closed = [];
		pushDialog({ onClose: () => closed.push("dialog") });
		handleEscapeKey({ key: "a", preventDefault() {} });
		handleEscapeKey(null);
		expect(closed).toEqual([]);
		popDialog({}); // unknown token: no-op
		handleEscapeKey(fakeEvent());
		expect(closed).toEqual(["dialog"]);
	});
});
