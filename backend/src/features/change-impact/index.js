// Public boundary for the change-impact feature (Phase 39A).
//
// Consumers should import from this barrel rather than reaching into individual
// modules, so the internal graph/traversal shapes stay free to evolve.

export { analyzeChange, analyzeChanges, analyzeWorkspaceDiff, buildGraph, DEFAULT_MAX_DEPTH, DIFF_KIND } from "./change-impact.service.js";
export { createChangeImpactAdapter, assertProfileScope, toWorkspaceCollection, toWorkspaceEnvironment } from "./change-impact-adapter.js";
export { buildDependencyGraph, orderedRequests } from "./dependency-graph.js";
export { traverseImpact } from "./impact-traversal.js";
export { buildImpactResult, IMPACT_KIND, IMPACT_SCHEMA_VERSION } from "./impact-result.js";
export { diffWorkspaces, diffParsedWorkspaces, sortChanges } from "./workspace-diff.js";
export { extractPlaceholders, scanScript, collectRequestReferences } from "./reference-extractor.js";
export { changeSeverity, severityForImpact, maxSeverity, SEVERITY_ORDER } from "./severity.js";
export { parseChange, parseWorkspace, canonicalChange, rootNodeIdOf, categoryOf, changeSchema, workspaceSchema } from "./change-impact-schema.js";
export * from "./node-ids.js";
