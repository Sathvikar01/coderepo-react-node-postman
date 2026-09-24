// Phase 46A — dependency resolution and deterministic ordering.
//
// This module owns exactly one job: turn a candidate set plus dependency
// information into (a) a classified edge list, (b) a set of explicitly
// represented cycles, and (c) a deterministic topological order.
//
// Invariants:
//
//   * Dependencies must appear before dependents whenever they are resolvable.
//   * A dependency that names a request outside the candidate set is EXTERNAL
//     and is preserved, never assumed satisfied.
//   * A dependency that is dynamic/unnameable is DYNAMIC and is preserved.
//   * A cycle is DETECTED and represented; it is never silently broken by
//     dropping edges or by falling back to arbitrary order.
//   * Ordering is deterministic and independent of the caller's input order:
//     two candidate sets that differ only in array order produce the identical
//     step order, because every tie is broken by requestId.
//
// The module never executes anything and never reads a clock.

import { DEPENDENCY_KINDS, CYCLE_KINDS } from "./reason-codes.js";
import { comparePlanStrings } from "./plan-identity.js";

// ---------------------------------------------------------------------------
// Candidate normalization
// ---------------------------------------------------------------------------

// Merge `candidates[].dependsOn` with an optional standalone `dependencies` list
// into one dependency map, then de-duplicate and sort. The union is taken so a
// caller can supply either shape without the planner silently ignoring one.
export function buildDependencyMap(candidates, dependencies) {
	const map = new Map();
	const ensure = (requestId) => {
		if (!map.has(requestId)) {
			map.set(requestId, { dependsOn: new Set(), dynamicDependencies: new Set() });
		}
		return map.get(requestId);
	};

	for (const candidate of candidates) {
		const entry = ensure(candidate.requestId);
		for (const dependency of candidate.dependsOn ?? []) {
			const id = String(dependency).trim();
			if (id) entry.dependsOn.add(id);
		}
		for (const marker of candidate.dynamicDependencies ?? []) {
			const text = String(marker).trim();
			if (text) entry.dynamicDependencies.add(text);
		}
	}

	for (const dependency of dependencies ?? []) {
		const entry = ensure(dependency.requestId);
		for (const target of dependency.dependsOn ?? []) {
			const id = String(target).trim();
			if (id) entry.dependsOn.add(id);
		}
		for (const marker of dependency.dynamicDependencies ?? []) {
			const text = String(marker).trim();
			if (text) entry.dynamicDependencies.add(text);
		}
	}

	return map;
}

// ---------------------------------------------------------------------------
// Edge classification
// ---------------------------------------------------------------------------

// Classify every dependency edge for a request. Returns a sorted, stable list:
// resolvable deps first (by id), then external (by id), then dynamic markers
// (by text). Every entry carries an explicit kind and an explicit `owner` (the
// request that declares the dependency), so nothing is implied and no consumer
// has to guess which end of an edge it is holding.
export function classifyDependencies(requestId, dependencyEntry, candidateIds) {
	const edges = [];
	const dependsOn = [...(dependencyEntry?.dependsOn ?? [])].sort(comparePlanStrings);
	for (const target of dependsOn) {
		let kind;
		if (target === requestId) kind = DEPENDENCY_KINDS.SELF;
		else if (candidateIds.has(target)) kind = DEPENDENCY_KINDS.RESOLVED;
		else kind = DEPENDENCY_KINDS.EXTERNAL;
		edges.push({ owner: requestId, requestId: target, marker: null, kind, target });
	}

	const dynamic = [...(dependencyEntry?.dynamicDependencies ?? [])].sort(comparePlanStrings);
	for (const marker of dynamic) {
		edges.push({ owner: requestId, requestId: null, marker, kind: DEPENDENCY_KINDS.DYNAMIC, target: `dynamic:${marker}` });
	}

	return edges;
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

// Tarjan's strongly-connected-components over the RESOLVED dependency graph.
// The graph is tiny by intent (a rehearsal set, not a whole workspace), so an
// iterative implementation is used for robustness rather than recursion depth.
//
// Only RESOLVED edges participate. A dependency on a request outside the
// candidate set cannot form a cycle *within* this plan, and treating it as one
// would fabricate a cycle.
export function detectCycles(candidateIds, resolvedEdges) {
	const adjacency = new Map();
	for (const id of candidateIds) adjacency.set(id, []);
	for (const edge of resolvedEdges) {
		if (edge.kind !== DEPENDENCY_KINDS.RESOLVED && edge.kind !== DEPENDENCY_KINDS.SELF) continue;
		adjacency.get(edge.owner).push(edge.target);
	}
	// Deterministic traversal: visit nodes and neighbours in sorted order.
	for (const [, neighbours] of adjacency) neighbours.sort(comparePlanStrings);

	const index = new Map();
	const lowlink = new Map();
	const onStack = new Set();
	const stack = [];
	const cycles = [];
	let counter = 0;

	const nodes = [...candidateIds].sort(comparePlanStrings);

	for (const start of nodes) {
		if (index.has(start)) continue;

		// Explicit work stack of [node, neighbourIndex].
		const work = [[start, 0]];
		index.set(start, counter);
		lowlink.set(start, counter);
		counter += 1;
		stack.push(start);
		onStack.add(start);

		while (work.length > 0) {
			const frame = work[work.length - 1];
			const [node, neighbourIndex] = frame;

			if (neighbourIndex < adjacency.get(node).length) {
				frame[1] += 1;
				const neighbour = adjacency.get(node)[neighbourIndex];
				if (!index.has(neighbour)) {
					index.set(neighbour, counter);
					lowlink.set(neighbour, counter);
					counter += 1;
					stack.push(neighbour);
					onStack.add(neighbour);
					work.push([neighbour, 0]);
				} else if (onStack.has(neighbour)) {
					lowlink.set(node, Math.min(lowlink.get(node), index.get(neighbour)));
				}
			} else {
				work.pop();
				if (work.length > 0) {
					const parent = work[work.length - 1][0];
					lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
				}
				if (lowlink.get(node) === index.get(node)) {
					const component = [];
					let member;
					do {
						member = stack.pop();
						onStack.delete(member);
						component.push(member);
					} while (member !== node);
					component.sort(comparePlanStrings);

					if (component.length > 1) {
						cycles.push({ kind: CYCLE_KINDS.MUTUAL, requestIds: component });
					} else {
						// A single-node component is a cycle only if the node depends
						// on itself, which registers as a SELF edge.
						const self = adjacency.get(component[0]).includes(component[0]);
						if (self) cycles.push({ kind: CYCLE_KINDS.SELF, requestIds: component });
					}
				}
			}
		}
	}

	cycles.sort((left, right) => {
		const byKind = comparePlanStrings(left.kind, right.kind);
		if (byKind !== 0) return byKind;
		return comparePlanStrings(left.requestIds.join("\u0000"), right.requestIds.join("\u0000"));
	});

	return cycles;
}

// ---------------------------------------------------------------------------
// Deterministic topological ordering (Kahn, tie-broken by requestId)
// ---------------------------------------------------------------------------

// Order the orderable requests so every resolvable dependency precedes its
// dependents. `orderable` excludes any request the planner has already decided
// is not executable (blocked/unknown/confirmation/unresolved/cyclic), and only
// RESOLVED edges among orderable requests constrain the order.
//
// Ties are broken by requestId, so the produced order is a pure function of the
// request set and the dependency structure — never of the caller's array order.
export function topologicalOrder(orderable, resolvedEdges) {
	const orderableSet = new Set(orderable);
	const indegree = new Map();
	const dependents = new Map();
	for (const id of orderable) {
		indegree.set(id, 0);
		dependents.set(id, new Set());
	}

	// Only edges whose both endpoints are orderable constrain the order.
	const edgeSeen = new Set();
	for (const edge of resolvedEdges) {
		if (edge.kind !== DEPENDENCY_KINDS.RESOLVED) continue;
		if (!orderableSet.has(edge.owner) || !orderableSet.has(edge.target)) continue;
		const key = `${edge.owner}\u0000${edge.target}`;
		if (edgeSeen.has(key)) continue;
		edgeSeen.add(key);
		dependents.get(edge.target).add(edge.owner);
		indegree.set(edge.owner, (indegree.get(edge.owner) ?? 0) + 1);
	}

	const ready = orderable.filter((id) => (indegree.get(id) ?? 0) === 0).sort(comparePlanStrings);
	const order = [];

	while (ready.length > 0) {
		const next = ready.shift();
		order.push(next);
		const children = [...(dependents.get(next) ?? [])].sort(comparePlanStrings);
		for (const child of children) {
			const remaining = (indegree.get(child) ?? 0) - 1;
			indegree.set(child, remaining);
			if (remaining === 0) {
				// Insert in sorted position so the ready queue stays ordered.
				let low = 0;
				let high = ready.length;
				while (low < high) {
					const mid = (low + high) >> 1;
					if (comparePlanStrings(ready[mid], child) < 0) low = mid + 1;
					else high = mid;
				}
				ready.splice(low, 0, child);
			}
		}
	}

	// Any orderable node left over means a cycle among orderable nodes. The
	// planner detects cycles before ordering, but returning the partial order and
	// the leftover set lets the caller fail closed instead of inventing an order.
	const ordered = new Set(order);
	const leftover = orderable.filter((id) => !ordered.has(id)).sort(comparePlanStrings);
	return { order, leftover };
}
