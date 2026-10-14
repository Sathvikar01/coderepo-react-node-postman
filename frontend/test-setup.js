// Bun's test runner has no DOM, but several frontend modules read browser
// globals at module-evaluation time (for example the API client seeds its
// in-memory session from localStorage). Because Bun loads test files into one
// process with a shared module registry, the first file that imports such a
// module decides whether it evaluates cleanly. Installing the browser globals in
// a preload — before any test file or application module loads — removes that
// run-order dependency so individual and combined suites behave identically.
//
// This is an in-memory test double, not a production shim: the real app always
// runs in a browser where these globals already exist.

if (typeof globalThis.localStorage === "undefined") {
	const store = new Map();
	globalThis.localStorage = {
		getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
		setItem: (key, value) => {
			store.set(String(key), String(value));
		},
		removeItem: (key) => {
			store.delete(String(key));
		},
		clear: () => {
			store.clear();
		},
		key: (index) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	};
}
