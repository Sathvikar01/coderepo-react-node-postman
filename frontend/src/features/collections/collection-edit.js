const newId = () => crypto.randomUUID();

export function cloneRequest(request) {
    return { ...structuredClone(request), id: newId(), folderId: request.folderId ?? null };
}

export function addRequest(aggregate, request, folderId = null, position = "end") {
    const next = { ...aggregate, requests: [...aggregate.requests] };
    const entry = { ...structuredClone(request), id: newId(), folderId: folderId ?? null };
    if (position === "start") next.requests.unshift(entry);
    else next.requests.push(entry);
    return { aggregate: next, request: entry };
}

export function updateRequest(aggregate, request) {
    return { ...aggregate, requests: aggregate.requests.map((item) => (item.id === request.id ? structuredClone(request) : item)) };
}

export function removeRequest(aggregate, requestId) {
    return { ...aggregate, requests: aggregate.requests.filter((item) => item.id !== requestId) };
}

export function duplicateRequest(aggregate, requestId) {
    const index = aggregate.requests.findIndex((item) => item.id === requestId);
    if (index === -1) return aggregate;
    const copy = cloneRequest(aggregate.requests[index]);
    copy.name = `${copy.name} copy`;
    const requests = [...aggregate.requests];
    requests.splice(index + 1, 0, copy);
    return { ...aggregate, requests };
}

export function moveRequest(aggregate, requestId, delta) {
    const request = aggregate.requests.find((item) => item.id === requestId);
    if (!request) return aggregate;
    const siblings = aggregate.requests.filter((item) => (item.folderId ?? null) === (request.folderId ?? null));
    const position = siblings.findIndex((item) => item.id === requestId);
    const target = siblings[position + delta];
    if (!target) return aggregate;
    const requests = [...aggregate.requests];
    const from = requests.findIndex((item) => item.id === requestId);
    const to = requests.findIndex((item) => item.id === target.id);
    requests.splice(from, 1);
    requests.splice(to, 0, request);
    return { ...aggregate, requests };
}

export function addFolder(aggregate, name) {
    const folder = { id: newId(), name };
    return { aggregate: { ...aggregate, folders: [...aggregate.folders, folder] }, folder };
}

export function renameFolder(aggregate, folderId, name) {
    return { ...aggregate, folders: aggregate.folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder)) };
}

export function deleteFolder(aggregate, folderId) {
    return {
        ...aggregate,
        folders: aggregate.folders.filter((folder) => folder.id !== folderId),
        requests: aggregate.requests.map((request) => (request.folderId === folderId ? { ...request, folderId: null } : request)),
    };
}

export function duplicateFolder(aggregate, folderId) {
    const folder = aggregate.folders.find((item) => item.id === folderId);
    if (!folder) return aggregate;
    const copyId = newId();
    const copies = aggregate.requests.filter((request) => request.folderId === folderId).map((request) => ({ ...cloneRequest(request), name: `${request.name} copy`, folderId: copyId }));
    return {
        ...aggregate,
        folders: [...aggregate.folders, { id: copyId, name: `${folder.name} copy` }],
        requests: [...aggregate.requests, ...copies],
    };
}

export function requestChangedSince(base, canonical) {
    if (!base) return canonical;
    const match = canonical.requests.find((item) => item.id === base.id);
    if (!match) return { missing: true };
    if (JSON.stringify(match) !== JSON.stringify(base)) return { changed: true };
    return null;
}
