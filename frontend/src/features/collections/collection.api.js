import { request } from "../../shared/api/client.js";

export const collectionApi = {
    list: () => request("/collections"),
    get: (collectionId) => request(`/collections/${collectionId}`),
    create: (input) => request("/collections", { method: "POST", body: JSON.stringify(input) }),
    update: (collectionId, expectedRevision, collection) => request(`/collections/${collectionId}`, { method: "PUT", body: JSON.stringify({ expectedRevision, collection }) }),
    duplicate: (collectionId, expectedRevision, name) => request(`/collections/${collectionId}/duplicate`, { method: "POST", body: JSON.stringify({ expectedRevision, name }) }),
    remove: (collectionId, revision) => request(`/collections/${collectionId}?revision=${revision}`, { method: "DELETE" }),
};
