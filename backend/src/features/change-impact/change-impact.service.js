import { parseChange, parseWorkspace, rootNodeIdOf } from "./change-impact-schema.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import { buildImpactResult, IMPACT_SCHEMA_VERSION } from "./impact-result.js";
import { traverseImpact } from "./impact-traversal.js";
import { diffParsedWorkspaces } from "./workspace-diff.js";

// Pure entry points for change-impact analysis.
//
// `analyzeChange` takes a workspace plus one proposed change. `analyzeWorkspaceDiff`
// takes two workspace snapshots and analyzes every difference between them. Both
// perform no I/O, mutate nothing, and never send a request.

export const DEFAULT_MAX_DEPTH = 32;
export const DIFF_KIND = "tracer.change-impact.diff";

export function buildGraph(workspace) {
	return buildDependencyGraph(parseWorkspace(workspace));
}

function analyzeAgainstGraph(graph, change, maxDepth) {
	const rootNodeId = rootNodeIdOf(change);
	const traversal = traverseImpact(graph, rootNodeId, { maxDepth });
	return buildImpactResult({ graph, change, traversal, unknowns: graph.unknowns, maxDepth });
}

export function analyzeChange({ workspace, change, maxDepth = DEFAULT_MAX_DEPTH }) {
	const parsedWorkspace = parseWorkspace(workspace);
	const parsedChange = parseChange(change);
	return analyzeAgainstGraph(buildDependencyGraph(parsedWorkspace), parsedChange, maxDepth);
}

export function analyzeChanges({ workspace, changes, maxDepth = DEFAULT_MAX_DEPTH }) {
	const parsedWorkspace = parseWorkspace(workspace);
	const graph = buildDependencyGraph(parsedWorkspace);
	return (changes ?? []).map((change) => analyzeAgainstGraph(graph, parseChange(change), maxDepth));
}

export function analyzeWorkspaceDiff({ before, after, changes, environmentId, maxDepth = DEFAULT_MAX_DEPTH }) {
	const parsedBefore = parseWorkspace(before);
	const parsedAfter = parseWorkspace(after);
	const selectedEnvironmentId = environmentId ?? parsedAfter.environmentId ?? parsedBefore.environmentId ?? null;
	// The graph is built from the "before" state because that is the workspace the
	// proposed changes are applied to; a removed node still exists there and its
	// dependents can be resolved.
	const base = {
		ownerProfileId: parsedBefore.ownerProfileId ?? parsedAfter.ownerProfileId ?? null,
		environmentId: parsedBefore.environments?.some((environment) => environment.id === selectedEnvironmentId) ? selectedEnvironmentId : null,
		collections: parsedBefore.collections,
		environments: parsedBefore.environments ?? [],
	};
	const proposed = changes && changes.length > 0 ? changes.map((change) => parseChange(change)) : diffParsedWorkspaces(parsedBefore, parsedAfter);
	const graph = buildDependencyGraph(parseWorkspace(base));
	const results = proposed.map((change) => analyzeAgainstGraph(graph, change, maxDepth));
	return {
		schemaVersion: IMPACT_SCHEMA_VERSION,
		kind: DIFF_KIND,
		environmentId: selectedEnvironmentId,
		changeCount: results.length,
		changes: results,
	};
}

export { parseChange, parseWorkspace, rootNodeIdOf };
