import { request } from "../../shared/api/client.js";

export const historyApi = {
    list: ({ cursor, limit = 50, method, outcome, q } = {}) => {
        const search = new URLSearchParams();
        if (cursor) search.set("cursor", cursor);
        if (limit) search.set("limit", String(limit));
        if (method) search.set("method", method);
        if (outcome) search.set("outcome", outcome);
        if (q) search.set("q", q);
        const query = search.toString();
        return request(`/history${query ? `?${query}` : ""}`);
    },
    get: (executionId) => request(`/history/${executionId}`),
    remove: (executionId) => request(`/history/${executionId}`, { method: "DELETE" }),
    clear: () => request("/history", { method: "DELETE" }),
};
