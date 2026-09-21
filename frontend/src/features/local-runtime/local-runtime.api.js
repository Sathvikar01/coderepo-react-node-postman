import { request } from "../../shared/api/client.js";

export const localRuntimeApi = {
	get: () => request("/local-runtime"),
	update: (input) => request("/local-runtime", { method: "PUT", body: JSON.stringify(input) }),
};
