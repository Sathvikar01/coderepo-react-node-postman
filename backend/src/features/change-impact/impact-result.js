import { canonicalChange, categoryOf } from "./change-impact-schema.js";
import { folderNode, nodeKindOf } from "./node-ids.js";
import { changeSeverity, maxSeverity, severityForImpact } from "./severity.js";

// Structured, deterministic result envelope for the change-impact engine.
//
// The core never emits prose. Every impact row carries a machine-readable category,
// severity, confidence, and the preserved dependency path that explains it.

export const IMPACT_KIND = "tracer.change-impact";
export const IMPACT_SCHEMA_VERSION = 1;

function compareStrings(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toItem(graph, entry, baseSeverity, change) {
	const node = graph.nodes.get(entry.node) ?? { id: entry.node, kind: nodeKindOf(entry.node) };
	const lastEdge = entry.path[entry.path.length - 1]?.edge ?? null;
	const item = {
		node: entry.node,
		nodeKind: node.kind,
		impact: entry.hop === 1 ? "direct" : "indirect",
		hop: entry.hop,
		category: categoryOf(change),
		severity: severityForImpact(baseSeverity, entry.hop),
		confidence: entry.confidence,
		path: entry.path,
		reason: lastEdge ? { type: lastEdge.type, detail: lastEdge.detail } : { type: "change-target", detail: {} },
	};
	for (const field of ["collectionId", "requestId", "folderId", "assertionId", "environmentId", "key", "name"]) {
		if (node[field] !== undefined && node[field] !== null) item[field] = node[field];
	}
	return item;
}

function unknownSortKey(unknown) {
	return [
		unknown.code ?? "",
		unknown.collectionId ?? "",
		unknown.requestId ?? "",
		unknown.field ?? "",
		unknown.key ?? "",
		unknown.fromRequestId ?? "",
	].join("\u0000");
}

function normalizeUnknown(unknown) {
	const output = { code: unknown.code };
	for (const field of ["key", "collectionId", "requestId", "field", "scope", "fromRequestId", "op", "rowId"]) {
		if (unknown[field] !== undefined && unknown[field] !== null) output[field] = unknown[field];
	}
	if (Array.isArray(unknown.environmentIds)) output.environmentIds = [...unknown.environmentIds].sort(compareStrings);
	return output;
}

export function buildImpactResult({ graph, change, traversal, unknowns = [], maxDepth = 32 }) {
	const canonical = canonicalChange(change);
	const baseSeverity = changeSeverity(canonical);
	const items = traversal.items.map((entry) => toItem(graph, entry, baseSeverity, canonical));

	const direct = items.filter((item) => item.hop === 1);
	const indirect = items.filter((item) => item.hop > 1);
	const requestItems = items.filter((item) => item.nodeKind === "request");
	const directRequests = requestItems.filter((item) => item.hop === 1);
	const indirectRequests = requestItems.filter((item) => item.hop > 1);
	const assertions = items.filter((item) => item.nodeKind === "assertion");

	const collectionMap = new Map();
	const folderMap = new Map();
	const ensureCollection = (collectionId) => {
		if (!collectionMap.has(collectionId))
			collectionMap.set(collectionId, {
				collectionId,
				name: graph.collectionById.get(collectionId)?.name ?? null,
				requestIds: new Set(),
				folderIds: new Set(),
			});
		return collectionMap.get(collectionId);
	};
	const ensureFolder = (collectionId, folderId) => {
		const mapKey = `${collectionId}:${folderId}`;
		if (!folderMap.has(mapKey))
			folderMap.set(mapKey, {
				collectionId,
				folderId,
				name: graph.nodes.get(folderNode(collectionId, folderId))?.name ?? null,
				requestIds: new Set(),
			});
		return folderMap.get(mapKey);
	};

	for (const item of items) {
		const node = graph.nodes.get(item.node);
		if (!node) continue;
		if (item.nodeKind === "request") {
			ensureCollection(node.collectionId).requestIds.add(node.requestId);
			if (node.folderId) {
				ensureCollection(node.collectionId).folderIds.add(node.folderId);
				ensureFolder(node.collectionId, node.folderId).requestIds.add(node.requestId);
			}
		} else if (item.nodeKind === "collection") {
			ensureCollection(node.collectionId);
		} else if (item.nodeKind === "folder") {
			ensureCollection(node.collectionId).folderIds.add(node.folderId);
			ensureFolder(node.collectionId, node.folderId);
		}
	}

	const collections = [...collectionMap.values()]
		.map((entry) => ({
			collectionId: entry.collectionId,
			name: entry.name,
			requestIds: [...entry.requestIds].sort(compareStrings),
			folderIds: [...entry.folderIds].sort(compareStrings),
		}))
		.sort((left, right) => compareStrings(left.collectionId, right.collectionId));

	const folders = [...folderMap.values()]
		.map((entry) => ({
			collectionId: entry.collectionId,
			folderId: entry.folderId,
			name: entry.name,
			requestIds: [...entry.requestIds].sort(compareStrings),
		}))
		.sort((left, right) => compareStrings(`${left.collectionId}:${left.folderId}`, `${right.collectionId}:${right.folderId}`));

	const unknownList = unknowns.map(normalizeUnknown).sort((left, right) => compareStrings(unknownSortKey(left), unknownSortKey(right)));
	if (!traversal.resolved)
		unknownList.unshift(normalizeUnknown({ code: "target-not-found", key: null, collectionId: null, requestId: null, field: null }));
	const sortedUnknown = unknownList.sort((left, right) => compareStrings(unknownSortKey(left), unknownSortKey(right)));
	if (traversal.truncated)
		sortedUnknown.push(normalizeUnknown({ code: "traversal-depth-limit", field: null, key: null }));

	let severity = "none";
	for (const item of items) severity = maxSeverity(severity, item.severity);

	return {
		schemaVersion: IMPACT_SCHEMA_VERSION,
		kind: IMPACT_KIND,
		change: canonical,
		resolved: traversal.resolved,
		summary: {
			directRequests: directRequests.length,
			indirectRequests: indirectRequests.length,
			totalRequests: requestItems.length,
			affectedCollections: collections.length,
			affectedFolders: folders.length,
			affectedAssertions: assertions.length,
			unknownReferences: sortedUnknown.length,
			severity,
		},
		impact: { direct, indirect },
		requests: { direct: directRequests, indirect: indirectRequests },
		collections,
		folders,
		assertions,
		unknown: sortedUnknown,
		truncated: traversal.truncated,
	};
}
