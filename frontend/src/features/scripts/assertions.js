export const ASSERTION_TARGETS = [
	{ value: "status", label: "Status" },
	{ value: "header", label: "Response header" },
	{ value: "body", label: "Body text" },
	{ value: "json", label: "JSON path" },
];

export const ASSERTION_OPERATORS = {
	status: [
		{ value: "equals", label: "Equals" },
		{ value: "range", label: "In range" },
	],
	header: [
		{ value: "exists", label: "Exists" },
		{ value: "equals", label: "Equals" },
		{ value: "contains", label: "Contains" },
	],
	body: [
		{ value: "contains", label: "Contains" },
		{ value: "equals", label: "Equals" },
	],
	json: [
		{ value: "exists", label: "Exists" },
		{ value: "equals", label: "Equals" },
	],
};

export const ASSERTION_VALUE_TYPES = [
	{ value: "string", label: "Text" },
	{ value: "number", label: "Number" },
	{ value: "boolean", label: "Boolean" },
	{ value: "null", label: "Null" },
];

export const ASSERTION_LIMIT = 50;

export function newAssertion(target = "status") {
	return {
		id: crypto.randomUUID(),
		name: "New assertion",
		enabled: true,
		target,
		operator: "",
		path: "",
		expected: "",
		valueType: "string",
		min: null,
		max: null,
		...targetDefaults(target),
	};
}

export function targetDefaults(target) {
	if (target === "status") return { operator: "equals", path: "", expected: "200", valueType: "string", min: null, max: null };
	if (target === "header") return { operator: "exists", path: "", expected: "", valueType: "string", min: null, max: null };
	if (target === "json") return { operator: "exists", path: "data.id", expected: "", valueType: "string", min: null, max: null };
	return { operator: "contains", path: "", expected: "", valueType: "string", min: null, max: null };
}

export function operatorDefaults(assertion) {
	const patch = {};
	if (assertion?.target === "status" && assertion.operator === "range") {
		if (assertion.min === null || assertion.min === undefined) patch.min = 200;
		if (assertion.max === null || assertion.max === undefined) patch.max = 299;
	}
	return patch;
}

export function assertionsOf(request) {
	return Array.isArray(request?.assertions) ? request.assertions : [];
}

export function enabledAssertionCount(request) {
	return assertionsOf(request).filter((assertion) => assertion?.enabled !== false).length;
}

function quote(value) {
	return `"${String(value ?? "").slice(0, 60)}"`;
}

export function describeAssertion(assertion) {
	if (!assertion) return "Assertion";
	const { target, operator, path, expected, valueType, min, max } = assertion;
	if (target === "status") {
		if (operator === "range") return `status in ${min ?? 100}-${max ?? 599}`;
		return `status equals ${expected || "?"}`;
	}
	if (target === "header") {
		if (operator === "exists") return `header ${path || "?"} exists`;
		if (operator === "contains") return `header ${path || "?"} contains ${quote(expected)}`;
		return `header ${path || "?"} equals ${quote(expected)}`;
	}
	if (target === "body") return `body ${operator === "equals" ? "equals" : "contains"} ${quote(expected)}`;
	if (operator === "exists") return `json ${path || "?"} exists`;
	if (valueType === "null") return `json ${path || "?"} is null`;
	return `json ${path || "?"} equals ${expected || "?"} (${valueType})`;
}
