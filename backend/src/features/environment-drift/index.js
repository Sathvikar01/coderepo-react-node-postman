// Phase 40A — Environment Drift Core.
//
// Public, backend-only engine that answers "how does the effective API
// configuration differ between two environments?" It is intentionally not wired
// to a route, the UI, snapshots, change impact, or execution. Later phases
// import this module through the interface below.
//
//   const report = analyzeEnvironmentDrift({ collection, sourceEnvironment, targetEnvironment });
//
// Nothing here resolves a secret, mutates state, or predicts runtime breakage.

export {
	ENVIRONMENT_DRIFT_KIND,
	ENVIRONMENT_DRIFT_SCHEMA_VERSION,
	DRIFT_CATEGORIES,
	DRIFT_SEVERITIES,
	DRIFT_STATUSES,
	environmentDriftResultSchema,
} from "./drift-schema.js";

export { adaptEnvironment, buildEffectiveEnvironmentState, buildWorkspaceReferences, collectTemplateReferences } from "./environment-state.js";
export { compareEnvironmentStates } from "./drift-comparator.js";
export { isBaseUrlKey, isVersionKey } from "./drift-severity.js";
export { analyzeEnvironmentDrift } from "./environment-drift.service.js";
