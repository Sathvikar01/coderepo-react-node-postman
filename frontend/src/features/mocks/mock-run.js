export function mockResolveInput({ request, environmentId, executionId }) {
	return {
		request,
		...(environmentId ? { environmentId } : {}),
		...(executionId ? { executionId } : {}),
	};
}

export async function runMockSend({ request, environmentId, executionId, api }) {
	return api.resolve(mockResolveInput({ request, environmentId, executionId }));
}

export function isMockResult(result) {
	return Boolean(result?.mock);
}

export function mockIndicator(mock) {
	if (!mock) return null;
	if (mock.matched)
		return {
			tone: "info",
			title: "Mock response",
			detail: `Served from the saved example "${mock.exampleName}" with no network request.`,
		};
	return {
		tone: "danger",
		title: "Mock miss",
		detail: `No saved example matches ${mock.target?.method ?? ""} ${mock.target?.path || "/"}. ${mock.considered ?? 0} example(s) were considered.`,
	};
}

export function mockRouteUrl(route) {
	if (!route) return "";
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	return `${origin}${route}`;
}
