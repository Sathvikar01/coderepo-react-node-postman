import { useMemo, useState } from "react";

const NODE_BUDGET = 2000;

function countNodes(value, budget = NODE_BUDGET) {
	let count = 0;
	const walk = (node) => {
		if (count > budget) return;
		count += 1;
		if (node && typeof node === "object") {
			const entries = Array.isArray(node) ? node : Object.values(node);
			for (const entry of entries) walk(entry);
		}
	};
	walk(value);
	return count;
}

function JsonValue({ value }) {
	if (value === null) return <span className="json-null">null</span>;
	if (typeof value === "string") return <span className="json-string">&quot;{value}&quot;</span>;
	if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
	if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
	return <span className="json-null">{String(value)}</span>;
}

function JsonNode({ name, value, depth }) {
	const [expanded, setExpanded] = useState(depth < 1);
	const isArray = Array.isArray(value);
	const isObject = value && typeof value === "object" && !isArray;
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
		try {
			const value = JSON.parse(text);
			const nodes = countNodes(value);
			if (nodes > NODE_BUDGET) return { error: `This document has more than ${NODE_BUDGET} nodes; use Raw view to inspect it.` };
			return { value };
		} catch (error) {
			return { error: `This response is not valid JSON (${error.message}). Use Raw view for the exact source.` };
		}
	}, [text]);
	if (parsed.error) return <p className="field-hint">{parsed.error}</p>;
	return (
		<div className="json-tree">
			<JsonNode depth={0} name={null} value={parsed.value} />
		</div>
	);
}
