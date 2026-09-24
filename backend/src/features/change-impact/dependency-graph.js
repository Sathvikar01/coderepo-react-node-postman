import { collectRequestReferences, extractPlaceholders, scanScript } from "./reference-extractor.js";
import {
	assertionNode,
	collectionAuthNode,
	collectionNode,
	collectionVariableNode,
	environmentNode,
	environmentVariableNode,
	folderNode,
	requestAuthNode,
	requestHeaderNode,
	requestNode,
	requestVariableNode,
	sharedHeaderNode,
} from "./node-ids.js";

// Dependency graph construction for the change-impact engine.
//
// Edges point from a dependent to its dependency (`from` depends on `to`). The
// returned `dependents` index inverts that so traversal can answer "what depends on
// this changed node?". Construction is pure and deterministic: every collection,
// variable, folder, request, header, assertion, and environment is visited in a
// stable sort order, so two equal workspaces always produce byte-identical graphs.

function byId(left, right) {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function byKey(left, right) {
	return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function enabled(variable) {
	return variable?.enabled !== false;
}

function hasEnabledVariable(scope, key) {
	return (scope?.variables ?? []).some((variable) => enabled(variable) && variable.key === key);
}

// Same ordering contract as the collection runner: folders in order (each with its
// requests in order), then root-level requests in order.
export function orderedRequests(collection) {
	const requests = collection?.requests ?? [];
	const ordered = [];
	for (const folder of collection?.folders ?? []) {
		for (const request of requests) if ((request.folderId ?? null) === folder.id) ordered.push(request);
	}
	for (const request of requests) if (!request.folderId) ordered.push(request);
	return ordered;
}

function variableTargets(key, collection, environments, selectedEnvironmentId, allowed) {
	const targets = [];
	let ambiguous = null;
	const envCandidates = environments.filter((environment) => hasEnabledVariable(environment, key));
	const collectionDeclares = hasEnabledVariable(collection, key);
	const allowEnvironment = allowed.includes("environment");
	const allowCollection = allowed.includes("collection");

	if (allowEnvironment && selectedEnvironmentId) {
		const selected = environments.find((environment) => environment.id === selectedEnvironmentId);
		if (selected && hasEnabledVariable(selected, key))
			targets.push({ node: environmentVariableNode(selected.id, key), scope: "environment", confidence: "exact" });
	} else if (allowEnvironment) {
		if (envCandidates.length === 1) {
			targets.push({ node: environmentVariableNode(envCandidates[0].id, key), scope: "environment", confidence: "exact" });
		} else if (envCandidates.length > 1) {
			for (const environment of envCandidates)
				targets.push({ node: environmentVariableNode(environment.id, key), scope: "environment", confidence: "unknown" });
			ambiguous = { code: "ambiguous-variable-scope", key, environmentIds: envCandidates.map((environment) => environment.id) };
		}
	}

	if (targets.length === 0 && allowCollection && collectionDeclares)
		targets.push({ node: collectionVariableNode(collection.id, key), scope: "collection", confidence: "exact" });

	return { targets, ambiguous };
}

function authReferenceTargets(auth) {
	const fields = [];
	if (auth?.mode === "bearer") fields.push("tokenTemplate");
	if (auth?.mode === "basic") fields.push("usernameTemplate", "passwordTemplate");
	if (auth?.mode === "apiKey") fields.push("valueTemplate");
	const collected = [];
	for (const field of fields) {
		for (const key of extractPlaceholders(auth[field]).keys) collected.push({ field, key });
	}
	return collected;
}

export function buildDependencyGraph(workspace) {
	const collections = [...workspace.collections].sort(byId);
	const environments = [...(workspace.environments ?? [])].sort(byId);
	const selectedEnvironmentId = workspace.environmentId ?? null;

	const nodes = new Map();
	const edges = [];
	const unknowns = [];
	const dependents = new Map();

	const addNode = (id, record) => {
		if (!nodes.has(id)) nodes.set(id, { id, ...record });
	};
	const addEdge = (from, to, type, detail = {}, confidence = "exact") => {
		if (!from || !to) return;
		const edge = { from, to, type, confidence, detail };
		edges.push(edge);
		if (!dependents.has(to)) dependents.set(to, []);
		dependents.get(to).push(edge);
	};
	const addUnknown = (unknown) => unknowns.push(unknown);

	for (const environment of environments) {
		addNode(environmentNode(environment.id), { kind: "environment", environmentId: environment.id, name: environment.name ?? null });
		for (const variable of [...(environment.variables ?? [])].sort(byKey)) {
			addNode(environmentVariableNode(environment.id, variable.key), {
				kind: "environmentVariable",
				environmentId: environment.id,
				key: variable.key,
				variableKind: variable.kind,
			});
		}
	}

	const requestMeta = new Map();
	const requestRunOrder = new Map();
	const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
	const environmentById = new Map(environments.map((environment) => [environment.id, environment]));

	for (const collection of collections) {
		addNode(collectionNode(collection.id), { kind: "collection", collectionId: collection.id, name: collection.name ?? null });

		for (const variable of [...(collection.variables ?? [])].sort(byKey)) {
			addNode(collectionVariableNode(collection.id, variable.key), {
				kind: "collectionVariable",
				collectionId: collection.id,
				key: variable.key,
				variableKind: variable.kind,
			});
		}

		for (const folder of [...(collection.folders ?? [])].sort(byId)) {
			addNode(folderNode(collection.id, folder.id), {
				kind: "folder",
				collectionId: collection.id,
				folderId: folder.id,
				name: folder.name ?? null,
			});
			addEdge(folderNode(collection.id, folder.id), collectionNode(collection.id), "container");
		}

		addNode(collectionAuthNode(collection.id), { kind: "collectionAuth", collectionId: collection.id, mode: collection.auth?.mode ?? "none" });
		for (const reference of authReferenceTargets(collection.auth)) {
			const resolution = variableTargets(reference.key, collection, environments, selectedEnvironmentId, ["environment", "collection"]);
			for (const target of resolution.targets)
				addEdge(collectionAuthNode(collection.id), target.node, "reference", { field: `auth.${reference.field}`, key: reference.key, scope: target.scope }, target.confidence);
			if (resolution.ambiguous) addUnknown({ ...resolution.ambiguous, collectionId: collection.id, requestId: null, field: `auth.${reference.field}` });
		}

		const ordered = orderedRequests(collection);
		const runOrder = new Map(ordered.map((request, index) => [request.id, index]));
		requestRunOrder.set(collection.id, runOrder);

		// First pass: nodes and per-request reference metadata.
		const requestInfo = new Map();
		for (const request of ordered) {
			const node = requestNode(collection.id, request.id);
			addNode(node, {
				kind: "request",
				collectionId: collection.id,
				requestId: request.id,
				folderId: request.folderId ?? null,
				name: request.name ?? null,
				method: request.method ?? null,
			});
			requestMeta.set(node, { collectionId: collection.id, requestId: request.id, folderId: request.folderId ?? null, name: request.name ?? null });
			addEdge(node, collectionNode(collection.id), "container");
			if (request.folderId) addEdge(node, folderNode(collection.id, request.folderId), "container");

			const { references, malformed } = collectRequestReferences(request);
			const preScript = scanScript(request.scripts?.preRequest);
			const testScript = scanScript(request.scripts?.test);

			const headerNodeByRow = new Map();
			for (const row of request.headers ?? []) {
				if (row.enabled === false) continue;
				const name = String(row.key ?? "").trim().toLowerCase();
				if (!name) continue;
				const headerNode = requestHeaderNode(collection.id, request.id, name);
				headerNodeByRow.set(row.id, headerNode);
				addNode(headerNode, { kind: "requestHeader", collectionId: collection.id, requestId: request.id, name });
				addEdge(node, headerNode, "header", { name });
				addNode(sharedHeaderNode(name), { kind: "sharedHeader", name });
				addEdge(headerNode, sharedHeaderNode(name), "shared-header", { name });
			}

			addNode(requestAuthNode(collection.id, request.id), {
				kind: "requestAuth",
				collectionId: collection.id,
				requestId: request.id,
				mode: request.auth?.mode ?? "none",
			});
			addEdge(node, requestAuthNode(collection.id, request.id), "auth");
			if (request.auth?.mode === "inherit") addEdge(requestAuthNode(collection.id, request.id), collectionAuthNode(collection.id), "auth-inherit");

			const writes = [];
			for (const write of preScript.writes) writes.push({ ...write, phase: "preRequest" });
			for (const write of testScript.writes) writes.push({ ...write, phase: "test" });

			requestInfo.set(request.id, {
				collection,
				request,
				node,
				runIndex: runOrder.get(request.id),
				references,
				malformed,
				preScript,
				testScript,
				writes,
				headerNodeByRow,
			});
		}

		// Second pass: request-variable producer nodes and assertion nodes.
		const writersByKey = new Map();
		for (const info of requestInfo.values()) {
			for (const write of info.writes) {
				const node = requestVariableNode(collection.id, info.request.id, write.key);
				addNode(node, {
					kind: "requestVariable",
					collectionId: collection.id,
					requestId: info.request.id,
					key: write.key,
					op: write.op,
					phase: write.phase,
				});
				addEdge(node, info.node, "produces", { key: write.key, op: write.op, phase: write.phase });
				if (!writersByKey.has(write.key)) writersByKey.set(write.key, []);
				writersByKey.get(write.key).push({ node, requestId: info.request.id, runIndex: info.runIndex, phase: write.phase, op: write.op });
			}
			for (const assertion of info.request.assertions ?? []) {
				if (assertion.enabled === false) continue;
				const node = assertionNode(collection.id, info.request.id, assertion.id);
				addNode(node, {
					kind: "assertion",
					collectionId: collection.id,
					requestId: info.request.id,
					assertionId: assertion.id,
					target: assertion.target ?? null,
					path: assertion.path ?? null,
					name: assertion.name ?? null,
				});
				addEdge(node, info.node, "assertion", { target: assertion.target ?? null, path: assertion.path ?? null });
			}
		}

		// Third pass: variable references and cross-request feeds.
		for (const info of requestInfo.values()) {
			const reads = [];
			for (const reference of info.references) {
				const isAuth = reference.field.startsWith("auth.");
				const from = isAuth ? requestAuthNode(collection.id, info.request.id) : info.node;
				if (reference.field === "headers" && reference.rowId && info.headerNodeByRow.has(reference.rowId)) {
					reads.push({ key: reference.key, field: reference.field, from: info.headerNodeByRow.get(reference.rowId), scope: "merged", rowId: reference.rowId });
				} else {
					reads.push({ key: reference.key, field: reference.field, from, scope: "merged", rowId: reference.rowId ?? null });
				}
			}
			for (const read of info.preScript.reads) reads.push({ key: read.key, field: "scripts.preRequest", from: info.node, scope: read.scope, rowId: null });
			for (const read of info.testScript.reads) reads.push({ key: read.key, field: "scripts.test", from: info.node, scope: read.scope, rowId: null });

			for (const read of reads) {
				const allowed = read.scope === "environment" ? ["environment"] : read.scope === "collection" ? ["collection"] : ["environment", "collection"];
				const resolution = variableTargets(read.key, collection, environments, selectedEnvironmentId, allowed);
				for (const target of resolution.targets)
					addEdge(read.from, target.node, "reference", { field: read.field, key: read.key, scope: target.scope, rowId: read.rowId }, target.confidence);
				if (resolution.ambiguous)
					addUnknown({ ...resolution.ambiguous, collectionId: collection.id, requestId: info.request.id, field: read.field });

				const writers = writersByKey.get(read.key) ?? [];
				let satisfied = resolution.targets.length > 0;
				for (const writer of writers) {
					const selfPreRequest = writer.requestId === info.request.id && writer.phase === "preRequest";
					if (selfPreRequest) {
						addEdge(info.node, writer.node, "self-feed", { field: read.field, key: read.key, phase: writer.phase });
						satisfied = true;
						continue;
					}
					if (writer.runIndex < info.runIndex) {
						addEdge(info.node, writer.node, "request-feed", { field: read.field, key: read.key, fromRequestId: writer.requestId }, "exact");
						satisfied = true;
						continue;
					}
					// A writer later in run order can only feed a later iteration. The
					// edge is real but not statically guaranteed, so it stays unknown.
					addEdge(info.node, writer.node, "request-feed", { field: read.field, key: read.key, fromRequestId: writer.requestId }, "unknown");
					addUnknown({
						code: "order-dependent-variable-feed",
						key: read.key,
						collectionId: collection.id,
						requestId: info.request.id,
						field: read.field,
						fromRequestId: writer.requestId,
					});
					satisfied = true;
				}
				if (!satisfied)
					addUnknown({
						code: "unresolved-variable",
						key: read.key,
						collectionId: collection.id,
						requestId: info.request.id,
						field: read.field,
					});
			}

			for (const malformed of info.malformed)
				addUnknown({ code: "malformed-placeholder", collectionId: collection.id, requestId: info.request.id, field: malformed.field, rowId: malformed.rowId ?? null });
			for (const dynamic of info.preScript.dynamicReads)
				addUnknown({ code: "dynamic-variable-read", collectionId: collection.id, requestId: info.request.id, field: "scripts.preRequest", scope: dynamic.scope ?? null });
			for (const dynamic of info.testScript.dynamicReads)
				addUnknown({ code: "dynamic-variable-read", collectionId: collection.id, requestId: info.request.id, field: "scripts.test", scope: dynamic.scope ?? null });
			for (const dynamic of info.preScript.dynamicWrites)
				addUnknown({ code: "dynamic-variable-write", collectionId: collection.id, requestId: info.request.id, field: "scripts.preRequest", op: dynamic.op });
			for (const dynamic of info.testScript.dynamicWrites)
				addUnknown({ code: "dynamic-variable-write", collectionId: collection.id, requestId: info.request.id, field: "scripts.test", op: dynamic.op });
		}
	}

	return {
		nodes,
		edges,
		dependents,
		unknowns,
		collectionById,
		environmentById,
		requestMeta,
		requestRunOrder,
	};
}
