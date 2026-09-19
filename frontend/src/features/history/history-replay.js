// History replay helpers: one deterministic path for turning a stored history record
// into a reusable request. Used by reopen, resend, and save-as so the three flows
// can never drift apart.

export function isReplayable(record) {
	return Boolean(record?.request?.schemaVersion);
}

export function materializeReplayRequest(record) {
	if (!isReplayable(record)) return null;
	const request = structuredClone(record.request);
	const effectiveAuth = record.snapshot?.effectiveAuth;
	if (request.auth?.mode === "inherit" && effectiveAuth && effectiveAuth.mode !== "inherit") {
		request.auth = structuredClone(effectiveAuth);
	}
	return request;
}

export function replayContext(record, { environmentId = null, environmentRevision = undefined, collectionExists = () => false } = {}) {
	const sourceCollectionId = record?.snapshot?.source?.collectionId ?? null;
	return {
		...(sourceCollectionId && collectionExists(sourceCollectionId)
			? { collectionId: sourceCollectionId, requestId: record.request?.id ?? null }
			: {}),
		...(environmentId ? { environmentId, environmentRevision } : {}),
	};
}
