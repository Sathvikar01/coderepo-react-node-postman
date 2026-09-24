import { nodeKindOf } from "./node-ids.js";

// Impact traversal over the dependency graph.
//
// `dependents` maps a dependency node to the edges whose `from` depends on it, so a
// breadth-first walk from the changed node yields everything that may be affected.
// Exact edges are traversed first, then non-exact (unknown/conditional) edges, so a
// node reachable both ways is reported with the stronger confidence. The visited
// set makes cyclic request-variable feeds terminate; `maxDepth` is a hard bound.

// Nodes that are structurally part of a request (its headers and auth wrapper) or a
// grouping (shared header). Crossing them does not count as a step of impact, so a
// request that references a changed variable through its header is still "direct".
const TRANSPARENT_KINDS = new Set(["requestHeader", "requestAuth", "collectionAuth", "sharedHeader"]);

function edgeSortKey(edge) {
	return `${edge.from}\u0000${edge.type}\u0000${JSON.stringify(edge.detail ?? {})}`;
}

function runBfs(graph, { initialQueue, visited, maxDepth, allow }) {
	const found = new Map();
	let truncated = false;
	const queue = [...initialQueue];

	while (queue.length > 0) {
		const current = queue.shift();
		const dependents = graph.dependents.get(current.node) ?? [];
		if (current.hop >= maxDepth) {
			if (dependents.some((edge) => allow(edge))) truncated = true;
			continue;
		}
		const ordered = [...dependents].sort((left, right) => {
			const leftKey = edgeSortKey(left);
			const rightKey = edgeSortKey(right);
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		});
		for (const edge of ordered) {
			if (!allow(edge)) continue;
			const dependent = edge.from;
			if (visited.has(dependent)) continue;
			visited.add(dependent);
			const step = {
				node: dependent,
				kind: graph.nodes.get(dependent)?.kind ?? nodeKindOf(dependent),
				edge: { type: edge.type, confidence: edge.confidence, detail: edge.detail },
			};
			const path = [...current.path, step];
			const hop = current.carryHop + 1;
			const carryHop = TRANSPARENT_KINDS.has(step.kind) ? current.carryHop : hop;
			const entry = { node: dependent, hop, carryHop, path, confidence: edge.confidence };
			found.set(dependent, entry);
			queue.push({ node: dependent, hop, carryHop, path });
		}
	}
	return { found, truncated };
}

export function traverseImpact(graph, rootNodeId, { maxDepth = 32 } = {}) {
	if (!graph.nodes.has(rootNodeId)) return { resolved: false, items: [], truncated: false };

	const rootStep = { node: rootNodeId, kind: graph.nodes.get(rootNodeId)?.kind ?? nodeKindOf(rootNodeId), edge: null };
	const rootEntry = { node: rootNodeId, hop: 0, carryHop: 0, path: [rootStep], confidence: "exact" };

	const exact = runBfs(graph, {
		initialQueue: [rootEntry],
		visited: new Set([rootNodeId]),
		maxDepth,
		allow: (edge) => edge.confidence === "exact",
	});

	const exactItems = [...exact.found.values()];
	const visited = new Set([rootNodeId, ...exactItems.map((item) => item.node)]);
	const frontier = exactItems.map((item) => ({ node: item.node, hop: item.hop, carryHop: item.carryHop, path: item.path }));

	const relaxed = runBfs(graph, {
		initialQueue: frontier.length > 0 ? frontier : [rootEntry],
		visited,
		maxDepth,
		allow: () => true,
	});

	const items = [
		...exactItems,
		...[...relaxed.found.values()].map((item) => ({ ...item, confidence: "unknown" })),
	].sort((left, right) => (left.node < right.node ? -1 : left.node > right.node ? 1 : 0));

	return { resolved: true, items, truncated: exact.truncated || relaxed.truncated };
}
