// Canonical node identifiers for the change-impact dependency graph.
//
// Every node id is a colon-delimited string. The delimiters are safe because the
// embedded values are constrained by the stored schemas: profile/collection/
// environment/folder/request/assertion ids are UUIDs, variable keys match
// [A-Za-z_][A-Za-z0-9_]*, and header names are lowercased HTTP tokens that cannot
// contain a colon. Ids are stable across runs so graph output is deterministic.

export const NODE_KIND = Object.freeze({
	environment: "environment",
	environmentVariable: "environmentVariable",
	collection: "collection",
	collectionVariable: "collectionVariable",
	folder: "folder",
	request: "request",
	requestVariable: "requestVariable",
	collectionAuth: "collectionAuth",
	requestAuth: "requestAuth",
	requestHeader: "requestHeader",
	sharedHeader: "sharedHeader",
	assertion: "assertion",
	missingVariable: "missingVariable",
	dynamicScript: "dynamicScript",
});

export const environmentNode = (environmentId) => `environment:${environmentId}`;
export const environmentVariableNode = (environmentId, key) => `environment-variable:${environmentId}:${key}`;
export const collectionNode = (collectionId) => `collection:${collectionId}`;
export const collectionVariableNode = (collectionId, key) => `collection-variable:${collectionId}:${key}`;
export const folderNode = (collectionId, folderId) => `folder:${collectionId}:${folderId}`;
export const requestNode = (collectionId, requestId) => `request:${collectionId}:${requestId}`;
export const requestVariableNode = (collectionId, requestId, key) => `request-variable:${collectionId}:${requestId}:${key}`;
export const collectionAuthNode = (collectionId) => `auth:collection:${collectionId}`;
export const requestAuthNode = (collectionId, requestId) => `auth:request:${collectionId}:${requestId}`;
export const requestHeaderNode = (collectionId, requestId, name) => `header:request:${collectionId}:${requestId}:${name}`;
export const sharedHeaderNode = (name) => `header:shared:${name}`;
export const assertionNode = (collectionId, requestId, assertionId) => `assertion:${collectionId}:${requestId}:${assertionId}`;
export const missingVariableNode = (key) => `missing-variable:${key}`;
export const dynamicScriptNode = (collectionId, requestId, phase) => `dynamic-script:${collectionId}:${requestId}:${phase}`;

export function nodeKindOf(id) {
	const value = String(id ?? "");
	if (value.startsWith("environment-variable:")) return NODE_KIND.environmentVariable;
	if (value.startsWith("environment:")) return NODE_KIND.environment;
	if (value.startsWith("collection-variable:")) return NODE_KIND.collectionVariable;
	if (value.startsWith("collection:")) return NODE_KIND.collection;
	if (value.startsWith("folder:")) return NODE_KIND.folder;
	if (value.startsWith("request-variable:")) return NODE_KIND.requestVariable;
	if (value.startsWith("request:")) return NODE_KIND.request;
	if (value.startsWith("auth:collection:")) return NODE_KIND.collectionAuth;
	if (value.startsWith("auth:request:")) return NODE_KIND.requestAuth;
	if (value.startsWith("header:request:")) return NODE_KIND.requestHeader;
	if (value.startsWith("header:shared:")) return NODE_KIND.sharedHeader;
	if (value.startsWith("assertion:")) return NODE_KIND.assertion;
	if (value.startsWith("missing-variable:")) return NODE_KIND.missingVariable;
	if (value.startsWith("dynamic-script:")) return NODE_KIND.dynamicScript;
	return "unknown";
}
