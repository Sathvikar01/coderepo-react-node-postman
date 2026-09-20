import { describe, expect, test } from "bun:test";
import { isExecutionActive, tabKeyIntent, workspaceHasUnsettledWork } from "./workspace-workflow.js";

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
