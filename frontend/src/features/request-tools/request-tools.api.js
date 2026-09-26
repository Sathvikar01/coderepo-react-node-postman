import { request } from "../../shared/api/client.js";

export const requestToolsApi = {
	parseCurl: (text) => request("/request-tools/import-curl", { method: "POST", body: JSON.stringify({ text }) }),
	generateSnippet: (requestDefinition, format, collectionAuth = null) =>
		request("/request-tools/snippet", {
			method: "POST",
			body: JSON.stringify({ request: requestDefinition, format, collectionAuth }),
		}),
};
