// Stable, documented process exit codes for the Tracer CLI.
//
// These are a public contract: CI jobs branch on them, so the numbers and their
// meanings must not drift. They are intentionally small and orthogonal:
//
//   0   the run completed and every executed request passed
//   1   the run completed but at least one request failed its checks
//   2   the invocation itself was invalid (bad arguments, malformed project,
//       unknown collection/environment, unusable configuration)
//   3   the runtime failed while trying to run (runner or execution error)
//   130 the run was cancelled by the user (SIGINT)
//
// A cancellation wins over a run failure because "the user stopped this" is a
// different outcome from "the target said no", and CI wants to tell them apart.

export const EXIT_CODES = Object.freeze({
	success: 0,
	runFailed: 1,
	invalidInput: 2,
	systemFailure: 3,
	cancelled: 130,
});

export const EXIT_CODE_MEANINGS = Object.freeze({
	0: "Success: the run completed and every executed request passed.",
	1: "Run failed: the run completed but at least one request failed.",
	2: "Invalid input or configuration: the CLI could not start the requested run.",
	3: "System failure: the runner or execution pipeline failed unexpectedly.",
	130: "Cancelled: the run was stopped before it finished.",
});

// Translate a finished run record into its exit code. The run record is the
// public payload returned by the collection runner, so this stays a pure mapping
// with no knowledge of how the run was executed.
export function exitCodeForRun(run) {
	if (!run) return EXIT_CODES.systemFailure;
	if (run.status === "cancelled" || run.stopReason === "cancelled" || run.summary?.cancelled > 0) return EXIT_CODES.cancelled;
	if (run.status === "failed") return EXIT_CODES.systemFailure;
	if (run.summary?.outcome === "failed" || run.summary?.failed > 0) return EXIT_CODES.runFailed;
	return EXIT_CODES.success;
}

// Status label used in machine output so consumers never have to infer intent
// from a bare number.
export function statusForExitCode(code) {
	if (code === EXIT_CODES.cancelled) return "cancelled";
	if (code === EXIT_CODES.runFailed) return "failed";
	if (code === EXIT_CODES.invalidInput) return "invalid";
	if (code === EXIT_CODES.systemFailure) return "error";
	return "success";
}
