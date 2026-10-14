import { describe, expect, test } from "bun:test";
import { dialogStackSize, popDialog, pushDialog } from "../../shared/components/dialog-stack.js";
import { isExecutionActive, tabKeyIntent, workspaceHasUnsettledWork, workspaceShortcutIntent } from "./workspace-workflow.js";

const tab = (overrides = {}) => ({
	id: "tab-1",
	dirty: false,
	executionId: null,
	status: "idle",
	...overrides,
});

describe("execution activity", () => {
	test("treats running and reconciling executions as active", () => {
		expect(isExecutionActive(tab({ status: "running", executionId: "exec-1" }))).toBe(true);
		expect(isExecutionActive(tab({ status: "reconciling", executionId: "exec-1" }))).toBe(true);
	});

	test("ignores settled, cancelled, error and idle tabs", () => {
		expect(isExecutionActive(tab({ status: "settled", executionId: "exec-1" }))).toBe(false);
		expect(isExecutionActive(tab({ status: "cancelled", executionId: "exec-1" }))).toBe(false);
		expect(isExecutionActive(tab({ status: "error", executionId: "exec-1" }))).toBe(false);
		expect(isExecutionActive(tab({ status: "running", executionId: null }))).toBe(false);
		expect(isExecutionActive(null)).toBe(false);
	});
});

describe("unsettled workspace detection", () => {
	test("flags dirty drafts and active executions before a profile switch", () => {
		expect(workspaceHasUnsettledWork([tab()])).toBe(false);
		expect(workspaceHasUnsettledWork([tab({ dirty: true })])).toBe(true);
		expect(workspaceHasUnsettledWork([tab({ status: "reconciling", executionId: "exec-1" })])).toBe(true);
		expect(workspaceHasUnsettledWork([])).toBe(false);
	});
});

describe("tab keyboard close", () => {
	test("Delete and Backspace close a focused tab", () => {
		expect(tabKeyIntent("Delete")).toBe("close");
		expect(tabKeyIntent("Backspace")).toBe("close");
	});

	test("other keys keep roving focus behavior", () => {
		expect(tabKeyIntent("Enter")).toBeNull();
		expect(tabKeyIntent("ArrowRight")).toBeNull();
	});
});

describe("workspace keyboard shortcuts", () => {
	test("Ctrl/Cmd+Enter sends and Ctrl/Cmd+S saves when no dialog is open", () => {
		expect(workspaceShortcutIntent({ key: "Enter", ctrlKey: true })).toBe("send");
		expect(workspaceShortcutIntent({ key: "s", metaKey: true })).toBe("save");
		expect(workspaceShortcutIntent({ key: "S", ctrlKey: true })).toBe("save");
		expect(workspaceShortcutIntent({ key: "s" })).toBeNull();
	});

	test("shortcuts stay inert while any modal on the dialog stack is open", () => {
		// Audit regression: Ctrl+S saved the request behind the open "New example"
		// dialog because that dialog was not in App's explicit open-dialog flags.
		// The stack is module state shared by every test file in one `bun test`
		// process, so compare against the size this test started with.
		const before = dialogStackSize();
		const token = { onClose: () => {} };
		pushDialog(token);
		try {
			const dialogOpen = dialogStackSize() > 0;
			expect(workspaceShortcutIntent({ key: "s", ctrlKey: true }, { dialogOpen })).toBeNull();
			expect(workspaceShortcutIntent({ key: "Enter", metaKey: true }, { dialogOpen })).toBeNull();
		} finally {
			popDialog(token);
		}
		expect(dialogStackSize()).toBe(before);
	});
});
