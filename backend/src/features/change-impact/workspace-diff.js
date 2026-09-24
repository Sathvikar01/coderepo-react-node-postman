import { parseWorkspace } from "./change-impact-schema.js";
import { scanScript } from "./reference-extractor.js";

// Pure workspace differ.
//
// This is the "snapshot A → snapshot B" side of the change-impact boundary. It reads
// two validated workspaces and produces the deterministic list of proposed changes
// that `analyzeChange` understands. It deliberately knows nothing about Phase 38
// snapshot storage: callers hand it two workspace documents.

const CHANGE_PRIORITY = {
	environment: 0,
	environmentVariable: 1,
	collection: 2,
	collectionVariable: 3,
	folder: 4,
	request: 5,
	auth: 6,
	header: 7,
};

function enabled(item) {
	return item?.enabled !== false;
}

function variableMap(variables) {
	const map = new Map();
	for (const variable of variables ?? []) {
		if (!enabled(variable)) continue;
		map.set(variable.key, variable);
	}
	return map;
}

function variableSignature(variable) {
	return JSON.stringify([variable.kind, variable.value ?? null, variable.alias ?? null]);
}

function authSignature(auth) {
	return JSON.stringify(auth ?? { mode: "none" });
}

function headerMap(headers) {
	const map = new Map();
	for (const row of headers ?? []) {
		if (!enabled(row)) continue;
		const name = String(row.key ?? "").trim().toLowerCase();
		if (!name) continue;
		map.set(name, row);
	}
	return map;
}

function writeMap(request) {
	const map = new Map();
	const scripts = { preRequest: scanScript(request.scripts?.preRequest), test: scanScript(request.scripts?.test) };
	for (const [phase, script] of Object.entries(scripts)) {
		for (const write of script.writes) {
			if (!map.has(write.key)) map.set(write.key, []);
			map.get(write.key).push(`${phase}:${write.op}`);
		}
	}
	for (const [key, list] of map) map.set(key, [...list].sort().join(","));
	return map;
}

function querySignature(request) {
	return JSON.stringify(
		(request.query ?? [])
			.filter((row) => enabled(row))
			.map((row) => [row.key, row.value])
			.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
	);
}

function requestSignature(request) {
	return JSON.stringify([
		request.method ?? "GET",
		request.urlTemplate,
		request.name ?? null,
		request.folderId ?? null,
		querySignature(request),
		JSON.stringify(request.body ?? { mode: "none" }),
	]);
}

const ignoreKeys = (object) => {
	const clone = { ...object };
	for (const key of ["ownerProfileId", "nameKey", "revision", "createdAt", "updatedAt", "_id", "__v"]) delete clone[key];
	return clone;
};

export function diffWorkspaces(before, after) {
	const parsedBefore = parseWorkspace(before);
	const parsedAfter = parseWorkspace(after);
	return diffParsedWorkspaces(parsedBefore, parsedAfter);
}

export function diffParsedWorkspaces(parsedBefore, parsedAfter) {
	const changes = [];
	const push = (operation, target) => changes.push({ operation, target });

	// Environments and their variables.
	const beforeEnvironments = new Map((parsedBefore.environments ?? []).map((environment) => [environment.id, environment]));
	const afterEnvironments = new Map((parsedAfter.environments ?? []).map((environment) => [environment.id, environment]));
	for (const [id, before] of beforeEnvironments) {
		const after = afterEnvironments.get(id);
		if (!after) {
			push("removed", { kind: "environment", environmentId: id });
			continue;
		}
		if ((ignoreKeys(before).name ?? null) !== (ignoreKeys(after).name ?? null))
			push("changed", { kind: "environment", environmentId: id });
		const beforeVariables = variableMap(before.variables);
		const afterVariables = variableMap(after.variables);
		for (const [key, beforeVariable] of beforeVariables) {
			const afterVariable = afterVariables.get(key);
			if (!afterVariable) push("removed", { kind: "environmentVariable", environmentId: id, key });
			else if (variableSignature(beforeVariable) !== variableSignature(afterVariable))
				push("changed", { kind: "environmentVariable", environmentId: id, key });
		}
	}

	// Collections, folders, requests, and their configuration.
	const beforeCollections = new Map(parsedBefore.collections.map((collection) => [collection.id, collection]));
	const afterCollections = new Map(parsedAfter.collections.map((collection) => [collection.id, collection]));
	for (const [collectionId, beforeCollection] of beforeCollections) {
		const afterCollection = afterCollections.get(collectionId);
		if (!afterCollection) {
			push("removed", { kind: "collection", collectionId });
			continue;
		}

		if ((ignoreKeys(beforeCollection).name ?? null) !== (ignoreKeys(afterCollection).name ?? null))
			push("changed", { kind: "collection", collectionId });

		const beforeVariables = variableMap(beforeCollection.variables);
		const afterVariables = variableMap(afterCollection.variables);
		for (const [key, beforeVariable] of beforeVariables) {
			const afterVariable = afterVariables.get(key);
			if (!afterVariable) push("removed", { kind: "collectionVariable", collectionId, key });
			else if (variableSignature(beforeVariable) !== variableSignature(afterVariable))
				push("changed", { kind: "collectionVariable", collectionId, key });
		}

		if (authSignature(beforeCollection.auth) !== authSignature(afterCollection.auth))
			push("changed", { kind: "auth", scope: "collection", collectionId });

		const afterFolders = new Set((afterCollection.folders ?? []).map((folder) => folder.id));
		for (const folder of beforeCollection.folders ?? []) if (!afterFolders.has(folder.id)) push("removed", { kind: "folder", collectionId, folderId: folder.id });

		const afterRequests = new Map((afterCollection.requests ?? []).map((request) => [request.id, request]));
		for (const beforeRequest of beforeCollection.requests ?? []) {
			const afterRequest = afterRequests.get(beforeRequest.id);
			if (!afterRequest) {
				push("removed", { kind: "request", collectionId, requestId: beforeRequest.id });
				continue;
			}

			if (requestSignature(beforeRequest) !== requestSignature(afterRequest))
				push("changed", { kind: "request", collectionId, requestId: beforeRequest.id });

			if (authSignature(beforeRequest.auth) !== authSignature(afterRequest.auth))
				push("changed", { kind: "auth", scope: "request", collectionId, requestId: beforeRequest.id });

			const beforeHeaders = headerMap(beforeRequest.headers);
			const afterHeaders = headerMap(afterRequest.headers);
			for (const [name, beforeHeader] of beforeHeaders) {
				const afterHeader = afterHeaders.get(name);
				if (!afterHeader) push("removed", { kind: "header", scope: "request", collectionId, requestId: beforeRequest.id, name });
				else if (beforeHeader.value !== afterHeader.value)
					push("changed", { kind: "header", scope: "request", collectionId, requestId: beforeRequest.id, name });
			}

			const beforeWrites = writeMap(beforeRequest);
			const afterWrites = writeMap(afterRequest);
			for (const [key, signature] of beforeWrites) {
				const afterSignature = afterWrites.get(key);
				if (afterSignature === undefined) push("removed", { kind: "requestVariable", collectionId, requestId: beforeRequest.id, key });
				else if (afterSignature !== signature) push("changed", { kind: "requestVariable", collectionId, requestId: beforeRequest.id, key });
			}
		}
	}

	return sortChanges(changes);
}

function changeSortKey(change) {
	const target = change.target;
	return [
		String(CHANGE_PRIORITY[target.kind] ?? 99).padStart(2, "0"),
		target.environmentId ?? target.collectionId ?? "",
		target.requestId ?? "",
		target.folderId ?? "",
		target.key ?? target.name ?? "",
		change.operation,
	];
}

export function sortChanges(changes) {
	return [...changes].sort((left, right) => {
		const leftKey = changeSortKey(left).join("\u0000");
		const rightKey = changeSortKey(right).join("\u0000");
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}
