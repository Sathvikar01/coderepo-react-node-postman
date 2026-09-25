import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";

// Phase 24B — snapshot safety.
//
// Snapshots hold the saved canonical definition only. Stored definitions are
// already credential-safe by construction: the zod schemas reject literal secret
// values in `secretRef` variables and require `{{variable}}` references in bearer,
// basic, and apiKey auth templates. The one free-form surface is header/query rows,
// where a collaborator could paste a literal token — those values are scrubbed
// here (structure preserved, value replaced) so diffs stay meaningful without ever
// persisting a credential.

const SENSITIVE_ROW_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|secret|password)$/i;
export const REDACTED = "[redacted]";

function scrubRows(rows) {
	if (!Array.isArray(rows)) return [];
	return rows.map((row) => {
		if (!row || typeof row !== "object") return row;
		if (typeof row.key === "string" && SENSITIVE_ROW_KEY.test(row.key.trim())) {
			return { ...row, value: REDACTED };
		}
		return { ...row };
	});
}

function scrubRequests(requests) {
	if (!Array.isArray(requests)) return [];
	return requests.map((request) => {
		if (!request || typeof request !== "object") return request;
		return {
			...request,
			headers: scrubRows(request.headers),
			query: scrubRows(request.query),
		};
	});
}

export function buildCollectionSnapshot(saved) {
	return {
		name: saved.name ?? "",
		description: saved.description ?? "",
		variables: Array.isArray(saved.variables) ? saved.variables.map((variable) => ({ ...variable })) : [],
		auth: saved.auth && typeof saved.auth === "object" ? { ...saved.auth } : { mode: "none" },
		folders: Array.isArray(saved.folders) ? saved.folders.map((folder) => ({ ...folder })) : [],
		requests: scrubRequests(saved.requests),
	};
}

export function buildEnvironmentSnapshot(saved) {
	return {
		name: saved.name ?? "",
		variables: Array.isArray(saved.variables) ? saved.variables.map((variable) => ({ ...variable })) : [],
	};
}

export function buildSafeSnapshot(resourceType, saved) {
	const snapshot =
		resourceType === "collection"
			? buildCollectionSnapshot(saved)
			: resourceType === "environment"
				? buildEnvironmentSnapshot(saved)
				: null;
	if (!snapshot) throw new Error(`Unsupported versioned resource type: ${resourceType}`);
	const bytes = utf8Bytes(JSON.stringify(snapshot));
	if (bytes > LIMITS.collectionJsonBytes) {
		throw new Error(`Version snapshot exceeds the ${LIMITS.collectionJsonBytes} byte canonical size limit.`);
	}
	return snapshot;
}

// Test and API-guard helper: assert a snapshot carries no credential material.
const SECRET_VALUE_PATTERN = /authorization\s*:\s*Bearer\s+\S+|cookie\s*:\s*\S+=|password\s*:\s*"\S+"/i;

export function snapshotHoldsSecrets(snapshot) {
	return SECRET_VALUE_PATTERN.test(JSON.stringify(snapshot));
}
