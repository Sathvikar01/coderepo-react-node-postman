import { request } from "../../shared/api/client.js";

export const cookieApi = {
	list: () => request("/cookies"),
	remove: (cookieId) => request(`/cookies/${cookieId}`, { method: "DELETE" }),
	clear: () => request("/cookies", { method: "DELETE" }),
};
