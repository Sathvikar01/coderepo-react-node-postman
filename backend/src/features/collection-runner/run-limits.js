// Collection-runner bounds. These keep a run deterministic and finite: the plan is
// capped before anything dispatches, and the loop stops on a wall-clock budget so a
// slow target cannot keep a run alive indefinitely. Kept in the feature rather than
// the shared limits module so the runner owns its own runaway-run policy.
export const RUN_LIMITS = {
	requestsPerRun: 100,
	iterationsPerRun: 25,
	stepsPerRun: 200,
	durationMs: 5 * 60 * 1000,
	variablesPerRun: 50,
	variableValueBytes: 8 * 1024,
	activeRunsPerProfile: 1,
	activeRunsPerProcess: 8,
	recentRunsLimit: 20,
	failureReasonBytes: 400,
};
