import { AppError } from "../../shared/errors/app-error.js";
import { RUN_LIMITS } from "./run-limits.js";

// Run plan building is pure so ordering and bounds are testable without a database.
//
// Ordering contract: a run always executes in the collection tree order the sidebar
// shows. Folders come first, in `folders` order, each folder contributing its
// requests in `requests` order; root-level requests follow in `requests` order. A
// folder selection keeps `requests` order for that folder, and an explicit request
// selection runs in exactly the order the caller listed. Iterations repeat the whole
// selection, so the plan is iteration-major and fully deterministic.

export function orderedRequests(collection) {
	const requests = collection?.requests ?? [];
	const ordered = [];
	for (const folder of collection?.folders ?? []) {
		for (const request of requests) {
			if ((request.folderId ?? null) === folder.id) ordered.push(request);
		}
	}
	for (const request of requests) {
		if (!request.folderId) ordered.push(request);
	}
	return ordered;
}

export function selectRequests(collection, selection) {
	if (selection?.mode === "requests") {
		const byId = new Map((collection?.requests ?? []).map((request) => [request.id, request]));
		return selection.requestIds.map((requestId) => {
			const request = byId.get(requestId);
			if (!request)
				throw new AppError(404, "REQUEST_NOT_FOUND", "A selected request no longer exists in this collection.", {
					requestId,
				});
			return request;
		});
	}
	if (selection?.mode === "folder") {
		const folder = (collection?.folders ?? []).find((item) => item.id === selection.folderId);
		if (!folder)
			throw new AppError(404, "FOLDER_NOT_FOUND", "The selected folder no longer exists in this collection.", {
				folderId: selection.folderId,
			});
		return (collection?.requests ?? []).filter((request) => (request.folderId ?? null) === folder.id);
	}
	return orderedRequests(collection);
}

export function buildRunPlan({ collection, selection, iterations }) {
	const count = Number.isInteger(iterations) && iterations > 0 ? iterations : 1;
	if (count > RUN_LIMITS.iterationsPerRun)
		throw new AppError(400, "RUN_TOO_LARGE", `A run may repeat at most ${RUN_LIMITS.iterationsPerRun} iterations.`, {
			limit: RUN_LIMITS.iterationsPerRun,
			actual: count,
			unit: "iterations",
		});
	const selected = selectRequests(collection, selection);
	if (selected.length === 0)
		throw new AppError(400, "RUN_SELECTION_EMPTY", "The run selection does not include any requests.");
	if (selected.length > RUN_LIMITS.requestsPerRun)
		throw new AppError(400, "RUN_TOO_LARGE", `A run may include at most ${RUN_LIMITS.requestsPerRun} requests.`, {
			limit: RUN_LIMITS.requestsPerRun,
			actual: selected.length,
			unit: "requests",
		});
	if (selected.length * count > RUN_LIMITS.stepsPerRun)
		throw new AppError(400, "RUN_TOO_LARGE", `A run may execute at most ${RUN_LIMITS.stepsPerRun} requests in total.`, {
			limit: RUN_LIMITS.stepsPerRun,
			actual: selected.length * count,
			unit: "steps",
		});
	const steps = [];
	for (let iteration = 1; iteration <= count; iteration += 1) {
		for (const request of selected) {
			steps.push({
				index: steps.length,
				iteration,
				requestId: request.id,
				name: request.name,
				method: request.method,
				snapshot: request,
			});
		}
	}
	return { steps, iterations: count, requestCount: selected.length, totalSteps: steps.length };
}
