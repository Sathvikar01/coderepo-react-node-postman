import { request } from "../../shared/api/client.js";

export const mockApi = {
	meta: () => request("/mocks/meta"),
	resolve: (input) => request("/mocks/resolve", { method: "POST", body: JSON.stringify(input) }),
};
