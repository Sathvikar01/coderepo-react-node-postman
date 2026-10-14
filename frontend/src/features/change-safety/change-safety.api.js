import { request } from "../../shared/api/client.js";

export const changeSafetyApi = {
	analyze: (input) =>
		request("/change-safety/analyze", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	generateContracts: (input) =>
		request("/change-safety/contracts", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	run: (input) =>
		request("/change-safety/run", {
			method: "POST",
			body: JSON.stringify(input),
		}),
};
