import { useMemo, useState } from "react";
import { parseJsonDocument } from "./json-format.js";

const NODE_BUDGET = 2000;

function isNumberLiteral(value) {
	return Boolean(value) && typeof value === "object" && typeof value.__number === "string";
}

function countNodes(value, budget = NODE_BUDGET) {
	const stack = [value];
	let count = 0;
	while (stack.length > 0 && count <= budget) {
		const node = stack.pop();
		count += 1;
		if (Array.isArray(node)) {
			for (const item of node) stack.push(item);
		} else if (node && typeof node === "object" && !isNumberLiteral(node)) {
			for (const item of Object.values(node)) stack.push(item);
		}
	}
	return count;
}

function JsonValue({ value }) {
	if (isNumberLiteral(value)) return <span className="json-number">{value.__number}</span>;
	if (value === null) return <span className="json-null">null</span>;
	if (typeof value === "string") return <span className="json-string">&quot;{value}&quot;</span>;
	if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
	if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
	return <span className="json-null">{String(value)}</span>;
}

function JsonNode({ name, value, depth }) {
	// Two levels open by default: a small object such as { error: { code, message } }
	// reads at a glance, while list items under a top-level array stay collapsed.
	const [expanded, setExpanded] = useState(depth < 2);
	const isArray = Array.isArray(value);
	const isObject = Boolean(value) && typeof value === "object" && !isArray && !isNumberLiteral(value);
	if (!isArray && !isObject) {
		return (
			<div className="json-row">
				<span className="json-toggle" />
				{name !== null && <span className="json-key">{name}:</span>}
				<JsonValue value={value} />
			</div>
		);
	}
	const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
	return (
		<div className="json-node">
			<div className="json-row">
				<button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${name ?? "value"}`}
					className="json-toggle"
					type="button"
					onClick={() => setExpanded((current) => !current)}
				>
					{expanded ? "▾" : "▸"}
				</button>
				{name !== null && <span className="json-key">{name}:</span>}
				<span className="json-null">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
			</div>
			{expanded && (
				<div className="json-children">
					{entries.map(([key, item]) => (
						<JsonNode key={String(key)} depth={depth + 1} name={isArray ? `[${key}]` : key} value={item} />
					))}
				</div>
			)}
		</div>
	);
}

export function JsonTree({ text }) {
	const parsed = useMemo(() => {
		const result = parseJsonDocument(text);
		if (!result.ok) return { error: `${result.reason} Use Raw view for the exact source.` };
		if (countNodes(result.value) > NODE_BUDGET)
			return { error: `This document has more than ${NODE_BUDGET} nodes; use Raw view to inspect it.` };
		return { value: result.value };
	}, [text]);
	if (parsed.error) return <p className="field-hint">{parsed.error}</p>;
	return (
		<div className="json-tree">
			<JsonNode depth={0} name={null} value={parsed.value} />
		</div>
	);
}
