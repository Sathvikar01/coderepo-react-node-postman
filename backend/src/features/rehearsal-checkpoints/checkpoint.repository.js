import mongoose from "mongoose";
import { RehearsalCheckpoint } from "./checkpoint.model.js";
import { RUN_STATES, STEP_STATES, TERMINAL_STEP_STATE_VALUES } from "./reason-codes.js";

// Phase 46B — Rehearsal checkpoint repository.
//
// Thin and profile-scoped: every read and write is constrained by ownerProfileId,
// so a run can never be observed or mutated across profiles.
//
// Every mutating method here is a single atomic `findOneAndUpdate` whose *filter*
// encodes the concurrency contract. Nothing in this file reads a document and then
// writes it back, because a read-then-write is exactly the race the checkpoint core
// exists to eliminate. The filters used are:
//
//   * `generation: <n>`        — the worker's ownership epoch must still be current.
//   * `runState: { $nin: [] }` — the run must still be non-terminal, as a query
//                                predicate, not an application check.
//   * `stepStates.stepId` +    — the target step must still be in the state the
//     `stepStates.state`         caller believed it was in (per-step CAS).
//
// A write that matches nothing returns null; the service turns that null into a
// deterministic typed error. The database is the arbiter, never in-memory state.

const SUMMARY =
	"runId schemaVersion kind runState generation owner lastOwnerGeneration identity identityFingerprint plan planFingerprint completedStepIds currentStepId nextStepId terminalReasonCode terminalReason completedAt abortedAt failedAt label createdAt updatedAt";

// Recompute the flat mirrors (`completedStepIds`, `nextStepId`, `currentStepId`)
// from the step array *after* a positional step write, inside the same atomic
// update. A plain `$set` would force the caller to precompute them from a stale
// read, which is the race the checkpoint core exists to eliminate.
function derivedPointerStages(generation) {
	return [
		{
			$set: {
				lastOwnerGeneration: generation,
				completedStepIds: {
					$sortArray: {
						input: {
							$map: {
								input: {
									$filter: {
										input: "$stepStates",
										as: "step",
										cond: { $in: ["$$step.state", TERMINAL_STEP_STATE_VALUES] },
									},
								},
								as: "done",
								in: "$$done.stepId",
							},
						},
						sortBy: 1,
					},
				},
				nextStepId: {
					$let: {
						vars: {
							remaining: {
								$filter: {
									input: "$plan.steps",
									as: "planStep",
									cond: {
										$not: [
											{
												$in: [
													"$$planStep.stepId",
													{
														$map: {
															input: { $filter: { input: "$stepStates", as: "s", cond: { $in: ["$$s.state", TERMINAL_STEP_STATE_VALUES] } } },
															as: "t",
															in: "$$t.stepId",
														},
													},
												],
											},
										],
									},
								},
							},
						},
						in: { $ifNull: [{ $first: "$$remaining.stepId" }, null] },
					},
				},
				currentStepId: {
					$let: {
						vars: {
							active: { $filter: { input: "$stepStates", as: "s", cond: { $eq: ["$$s.state", "IN_PROGRESS"] } } },
						},
						in: { $ifNull: [{ $first: "$$active.stepId" }, null] },
					},
				},
			},
		},
	];
}

export const checkpointRepository = {
	// Insert a brand-new run. A duplicate (profile, runId) surfaces as a Mongo
	// duplicate-key error, which the service maps to a deterministic conflict.
	insertRun: (document) => RehearsalCheckpoint.create(document),

	findByRunId: (ownerProfileId, runId) => RehearsalCheckpoint.findOne({ ownerProfileId, runId }).lean(),

	findById: (ownerProfileId, id) => RehearsalCheckpoint.findOne({ _id: id, ownerProfileId }).lean(),

	listForProfile: (ownerProfileId, { runState } = {}) =>
		RehearsalCheckpoint.find({ ownerProfileId, ...(runState ? { runState } : {}) })
			.sort({ createdAt: -1 })
			.select(SUMMARY)
			.lean(),

	// Resumable runs: everything that is not terminal.
	listResumable: (ownerProfileId) =>
		RehearsalCheckpoint.find({
			ownerProfileId,
			runState: { $in: [RUN_STATES.CREATED, RUN_STATES.RUNNING, RUN_STATES.PAUSED] },
		})
			.sort({ createdAt: -1 })
			.select(SUMMARY)
			.lean(),

	// -----------------------------------------------------------------------
	// Claim / start — the only operation that advances the generation.
	// -----------------------------------------------------------------------
	//
	// Claiming is a single atomic increment of `generation` guarded by the expected
	// generation and by the run being non-terminal. Two workers racing to claim the
	// same run cannot both win: the first `$inc` changes `generation`, and the
	// second's filter no longer matches.
	//
	// `from` is the expected current generation. The stored generation after a
	// successful claim is always `from + 1`.
	claim: (ownerProfileId, runId, { from, owner, toState }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{
				ownerProfileId,
				runId,
				generation: from,
				runState: { $in: [RUN_STATES.CREATED, RUN_STATES.RUNNING, RUN_STATES.PAUSED] },
			},
			{
				$inc: { generation: 1 },
				$set: { owner, lastOwnerGeneration: from + 1, ...(toState ? { runState: toState } : {}) },
			},
			{ new: true },
		).lean(),

	// -----------------------------------------------------------------------
	// Checkpoint a step — generation-guarded, per-step CAS, self-consistent.
	// -----------------------------------------------------------------------
	//
	// The filter requires: the profile, the run, the current generation, a
	// non-terminal run, and the target step currently in one of `fromStepStates`.
	// Setting a step twice from a terminal state therefore cannot match at all; the
	// service handles the idempotent case explicitly before reaching here, and
	// this write exists only for the genuine "advance the step" path.
	//
	// This is an AGGREGATION PIPELINE update, not a plain `$set`, and that is the
	// point. The derived fields — `completedStepIds`, `currentStepId`, `nextStepId`
	// — are computed from the step array *after* this write's positional change,
	// inside the same atomic update. A plain `$set` would require the caller to
	// precompute them from a read taken before the write, so two concurrent
	// checkpoints of different steps would each write a "completed" list that
	// predates the other and one would silently erase the other's progress. Deriving
	// them here makes the flat mirror provably agree with the step array in every
	// interleaving.
	//
	// Pipeline stages are evaluated in order, so `map` (stage 1) produces the
	// updated step array and stage 2 reads that same updated array via `$stepStates`.
	checkpointStep: (ownerProfileId, runId, { generation, owner, stepId, fromStepStates, changes }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{
				ownerProfileId,
				runId,
				generation,
				owner,
				runState: { $in: [RUN_STATES.CREATED, RUN_STATES.RUNNING] },
				stepStates: { $elemMatch: { stepId, state: { $in: fromStepStates } } },
			},
			[
				{
					$set: {
						stepStates: {
							$map: {
								input: "$stepStates",
								as: "step",
								in: {
									$cond: [
										{ $eq: ["$$step.stepId", stepId] },
										{
											$mergeObjects: [
												"$$step",
												{
													state: changes.stepState,
													completion: changes.completion,
													attempt: changes.attempt,
													lastReasonCode: changes.lastReasonCode ?? null,
												},
											],
										},
										"$$step",
									],
								},
							},
						},
					},
				},
				{
					// Derived-from-the-updated-array: the flat completed mirror and the
					// next/current pointers, in plan order, never from a stale pre-read.
					$set: {
						lastOwnerGeneration: generation,
						completedStepIds: {
							$sortArray: {
								input: {
									$map: {
										input: {
											$filter: {
												input: "$stepStates",
												as: "step",
												cond: { $in: ["$$step.state", TERMINAL_STEP_STATE_VALUES] },
											},
										},
										as: "done",
										in: "$$done.stepId",
									},
								},
								sortBy: 1,
							},
						},
						nextStepId: {
							$let: {
								vars: {
									remaining: {
										$filter: {
											input: "$plan.steps",
											as: "planStep",
											cond: {
												$not: [
													{
														$in: [
															"$$planStep.stepId",
															{
																$map: {
																	input: { $filter: { input: "$stepStates", as: "s", cond: { $in: ["$$s.state", TERMINAL_STEP_STATE_VALUES] } } },
																	as: "t",
																	in: "$$t.stepId",
																},
															},
														],
													},
												],
											},
										},
									},
								},
								in: { $ifNull: [{ $first: "$$remaining.stepId" }, null] },
							},
						},
						currentStepId: {
							$let: {
								vars: {
									active: { $filter: { input: "$stepStates", as: "s", cond: { $eq: ["$$s.state", "IN_PROGRESS"] } } },
								},
								in: { $ifNull: [{ $first: "$$active.stepId" }, null] },
							},
						},
					},
				},
			],
			{ new: true },
		).lean(),

	// -----------------------------------------------------------------------
	// Step claim / release — the in-flight marker that makes an ambiguous remote
	// side effect detectable.
	// -----------------------------------------------------------------------
	//
	// A worker marks a step IN_PROGRESS *before* it dispatches the remote request.
	// If the process dies between dispatch and checkpoint, the step is left
	// IN_PROGRESS, so a later resume can see that the side effect may already have
	// happened instead of blindly replaying it. The claim is generation- and
	// owner-guarded and per-step CAS (PENDING -> IN_PROGRESS), so two workers cannot
	// both claim the same step; the attempt counter advances exactly once per claim.
	beginStep: (ownerProfileId, runId, { generation, owner, stepId, fromStepStates }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{
				ownerProfileId,
				runId,
				generation,
				owner,
				runState: { $in: [RUN_STATES.CREATED, RUN_STATES.RUNNING] },
				stepStates: { $elemMatch: { stepId, state: { $in: fromStepStates } } },
			},
			[
				{
					$set: {
						stepStates: {
							$map: {
								input: "$stepStates",
								as: "step",
								in: {
									$cond: [
										{ $eq: ["$$step.stepId", stepId] },
										{
											$mergeObjects: [
												"$$step",
												{
													state: STEP_STATES.IN_PROGRESS,
													attempt: {
														attempts: { $add: [{ $ifNull: ["$$step.attempt.attempts", 0] }, 1] },
														ownerGeneration: generation,
														evidenceRefs: { $ifNull: ["$$step.attempt.evidenceRefs", []] },
													},
													lastReasonCode: null,
												},
											],
										},
										"$$step",
									],
								},
							},
						},
					},
				},
				...derivedPointerStages(generation),
			],
			{ new: true },
		).lean(),

	// Release an in-flight claim without recording an outcome. Used when a worker
	// cancels or times out *during* dispatch: the request was aborted, so no
	// ambiguous side effect exists and a later resume may safely re-run the step.
	releaseStep: (ownerProfileId, runId, { generation, owner, stepId, fromStepStates }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{
				ownerProfileId,
				runId,
				generation,
				owner,
				runState: { $in: [RUN_STATES.CREATED, RUN_STATES.RUNNING] },
				stepStates: { $elemMatch: { stepId, state: { $in: fromStepStates } } },
			},
			[
				{
					$set: {
						stepStates: {
							$map: {
								input: "$stepStates",
								as: "step",
								in: {
									$cond: [
										{ $eq: ["$$step.stepId", stepId] },
										{ $mergeObjects: ["$$step", { state: STEP_STATES.PENDING }] },
										"$$step",
									],
								},
							},
						},
					},
				},
				...derivedPointerStages(generation),
			],
			{ new: true },
		).lean(),

	// -----------------------------------------------------------------------
	// Terminal transitions — generation-guarded, state-guarded.
	// -----------------------------------------------------------------------
	//
	// Each terminal transition names the exact `from` state(s) it may be applied
	// from, so a COMPLETED run cannot be aborted and an ABORTED run cannot fail. The
	// generation guard means a stale worker cannot terminate a newer generation.
	markTerminal: (ownerProfileId, runId, { generation, owner, fromStates, toState, fields }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{
				ownerProfileId,
				runId,
				generation,
				owner,
				runState: { $in: fromStates },
			},
			{ $set: { runState: toState, lastOwnerGeneration: generation, ...fields } },
			{ new: true },
		).lean(),

	// Move RUNNING -> PAUSED. Generation-guarded.
	pause: (ownerProfileId, runId, { generation, owner }) =>
		RehearsalCheckpoint.findOneAndUpdate(
			{ ownerProfileId, runId, generation, owner, runState: RUN_STATES.RUNNING },
			{ $set: { runState: RUN_STATES.PAUSED, lastOwnerGeneration: generation } },
			{ new: true },
		).lean(),

	// -----------------------------------------------------------------------
	// Ownership probe — read-only.
	// -----------------------------------------------------------------------
	//
	// Used by the service only to produce a precise error. It never participates in
	// a write decision; the write filters above are authoritative.
	findOwnership: (ownerProfileId, runId) =>
		RehearsalCheckpoint.findOne({ ownerProfileId, runId })
			.select("runId runState generation owner lastOwnerGeneration completedStepIds")
			.lean(),

	// -----------------------------------------------------------------------
	// Maintenance
	// -----------------------------------------------------------------------
	deleteRun: (ownerProfileId, runId) => RehearsalCheckpoint.findOneAndDelete({ ownerProfileId, runId }).lean(),

	// Delete only terminal runs older than a cutoff. Used by reset/cleanup so a
	// cleanup can never delete in-flight work.
	deleteTerminalBefore: (ownerProfileId, cutoff) =>
		RehearsalCheckpoint.deleteMany({
			ownerProfileId,
			runState: { $in: [RUN_STATES.COMPLETED, RUN_STATES.ABORTED, RUN_STATES.FAILED] },
			updatedAt: { $lt: cutoff },
		}),

	countForProfile: (ownerProfileId) => RehearsalCheckpoint.countDocuments({ ownerProfileId }),
	// `aggregate` does not apply Mongoose schema casting, so the profile id is cast
	// explicitly here. Without that, a string id silently matches nothing and the
	// state breakdown comes back empty even though the runs exist.
	countByState: (ownerProfileId) =>
		RehearsalCheckpoint.aggregate([
			{ $match: { ownerProfileId: new mongoose.Types.ObjectId(String(ownerProfileId)) } },
			{ $group: { _id: "$runState", count: { $sum: 1 } } },
			{ $sort: { _id: 1 } },
		]),

	deleteAllForProfile: (ownerProfileId) => RehearsalCheckpoint.deleteMany({ ownerProfileId }),
};
