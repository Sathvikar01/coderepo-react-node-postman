import { AppError } from "../../../shared/errors/app-error.js";
import { regressionRepository } from "./regression.repository.js";
import {
	buildRegressionTimeline,
	lineageOf,
	parseFailurePredicate,
	REGRESSION_WINDOW_DEFAULT,
	REGRESSION_WINDOW_MAX,
	selectFailurePredicate,
} from "./regression-timeline.js";

function isExpired(record, now) {
	if (record?.expiresAt == null) return false;
	const time = new Date(record.expiresAt).getTime();
	return !Number.isNaN(time) && time <= now;
}

export function createRegressionService({ repository = regressionRepository, now = () => Date.now() } = {}) {
	// Profile isolation is enforced here as well as in the query: records that do not belong
	// to the requesting profile are dropped before any evidence is evaluated.
	function scoped(record, profileId) {
		if (!record) return null;
		return String(record.ownerProfileId) === String(profileId) ? record : null;
	}

	return {
		// Builds RegressionTimelineV1 for one recorded execution. Evidence comes from recorded
		// history only; nothing is replayed and no causal claim is made.
		async buildTimeline(profileId, executionId, options = {}) {
			const at = now();
			const limit = Math.min(Math.max(Number(options.limit) || REGRESSION_WINDOW_DEFAULT, 1), REGRESSION_WINDOW_MAX);
			const anchor = scoped(await repository.findAnchor(profileId, executionId), profileId);
			if (!anchor || anchor.visible === false || isExpired(anchor, at))
				throw new AppError(404, "HISTORY_NOT_FOUND", "The requested history entry does not exist.");

			let parsed;
			if (options.predicate === undefined) {
				parsed = parseFailurePredicate(selectFailurePredicate(anchor));
				if (!parsed.ok) parsed = parseFailurePredicate({ type: "outcome", equals: anchor.outcome ?? "unknown" });
			} else {
				parsed = parseFailurePredicate(options.predicate);
				if (!parsed.ok)
					throw new AppError(422, "PREDICATE_INVALID", "The selected failure predicate is not supported.", { issues: parsed.issues });
			}

			const lineage = lineageOf(anchor);
			// Fail closed: without a trustworthy lineage nothing is grouped and no query runs.
			if (!lineage.ok)
				return buildRegressionTimeline({ anchor, records: [anchor], predicate: parsed.predicate, window: { limit }, now: at });

			const window = await repository.findLineageWindow(
				profileId,
				lineage.lineage,
				{ startedAt: anchor.startedAt, executionId: anchor.executionId },
				limit,
			);
			const records = [anchor, ...(window ?? []).map((record) => scoped(record, profileId)).filter(Boolean)];
			return buildRegressionTimeline({
				anchor,
				records,
				predicate: parsed.predicate,
				window: { limit, truncated: (window ?? []).length >= limit },
				now: at,
			});
		},
	};
}

export const regressionService = createRegressionService();
