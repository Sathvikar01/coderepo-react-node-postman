const DROP = Symbol("drop");

function pathKey(path) {
	return JSON.stringify(path);
}

function collectJsonNodes(value, path, out) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			const next = [...path, index];
			out.push({ kind: "json", path: next, key: next.join(".") });
			collectJsonNodes(item, next, out);
		});
		return;
	}
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) {
			const next = [...path, key];
			out.push({ kind: "json", path: next, key: next.join(".") });
			collectJsonNodes(value[key], next, out);
		}
	}
}

function parseJsonBody(request) {
	if (request?.body?.mode !== "json") return undefined;
	try {
		const value = JSON.parse(request.body.text);
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function enumerateComponents(request) {
	const components = [];
	for (const kind of ["query", "header"]) {
		const list = (kind === "query" ? request?.query : request?.headers) ?? [];
		for (const row of list) {
			if (row?.enabled === false || !row?.id) continue;
			components.push({ kind, id: row.id, key: row.key ?? "" });
		}
	}
	const body = parseJsonBody(request);
	if (body !== undefined) collectJsonNodes(body, [], components);
	return components;
}

export function componentRef(component) {
	return component.kind === "json" ? `json:${pathKey(component.path)}` : `${component.kind}:${component.id}`;
}

export function describeComponent(component) {
	if (component.kind === "json") return { kind: component.kind, key: component.key, path: [...component.path] };
	return { kind: component.kind, key: component.key, id: component.id };
}

export function isDescendantPath(path, ancestor) {
	return ancestor.length < path.length && ancestor.every((segment, index) => segment === path[index]);
}

function removePaths(value, drop, path) {
	if (drop.has(pathKey(path))) return DROP;
	if (Array.isArray(value)) {
		const next = [];
		value.forEach((item, index) => {
			const child = removePaths(item, drop, [...path, index]);
			if (child !== DROP) next.push(child);
		});
		return next;
	}
	if (value && typeof value === "object") {
		const next = {};
		for (const key of Object.keys(value)) {
			const child = removePaths(value[key], drop, [...path, key]);
			if (child !== DROP) next[key] = child;
		}
		return next;
	}
	return value;
}

export function withoutComponents(request, components) {
	const candidate = structuredClone(request);
	for (const kind of ["query", "header"]) {
		const dropped = new Set(components.filter((component) => component.kind === kind).map((component) => component.id));
		if (dropped.size === 0) continue;
		const list = (kind === "query" ? candidate.query : candidate.headers) ?? [];
		const next = list.filter((row) => !dropped.has(row.id));
		if (kind === "query") candidate.query = next;
		else candidate.headers = next;
	}
	const dropPaths = new Set(components.filter((component) => component.kind === "json").map((component) => pathKey(component.path)));
	if (dropPaths.size > 0) {
		const body = parseJsonBody(candidate);
		if (body !== undefined) candidate.body = { ...candidate.body, text: JSON.stringify(removePaths(body, dropPaths, [])) };
	}
	return candidate;
}

export function splitChunks(items, chunkCount) {
	const count = Math.max(1, Math.min(chunkCount, items.length));
	const size = Math.floor(items.length / count);
	const extra = items.length % count;
	const chunks = [];
	let offset = 0;
	for (let index = 0; index < count; index += 1) {
		const width = size + (index < extra ? 1 : 0);
		chunks.push(items.slice(offset, offset + width));
		offset += width;
	}
	return chunks;
}
