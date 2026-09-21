import vm from "node:vm";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { scanForbiddenTokens } from "./script-scanner.js";

export const SANDBOX_VERSION = "1.0";

const CONSOLE_LEVELS = new Set(["log", "info", "warn", "error", "debug"]);
const TEST_STATUSES = new Set(["passed", "failed"]);

const SANDBOX_LIMITS = Object.freeze({
	consoleEntries: LIMITS.scriptConsoleEntries,
	tests: LIMITS.scriptTests,
	mutations: LIMITS.scriptMutations,
	textFieldChars: LIMITS.scriptTextFieldBytes,
	timeoutMs: LIMITS.scriptTimeoutMs,
});

const HARDENING_SOURCE = `
	try { Object.getPrototypeOf(function () {}).constructor = undefined; } catch (e) {}
	try { Object.getPrototypeOf(async function () {}).constructor = undefined; } catch (e) {}
	try { Object.getPrototypeOf(async () => {}).constructor = undefined; } catch (e) {}
	try { Object.getPrototypeOf(function* () {}).constructor = undefined; } catch (e) {}
	try { Object.getPrototypeOf(async function* () {}).constructor = undefined; } catch (e) {}
	try {
		var asyncProto = Object.getPrototypeOf(async function () {});
		delete asyncProto.constructor;
	} catch (e) {}
	try {
		var generatorProto = Object.getPrototypeOf(function* () {});
		delete generatorProto.constructor;
	} catch (e) {}
	try {
		var asyncGeneratorProto = Object.getPrototypeOf(async function* () {});
		delete asyncGeneratorProto.constructor;
	} catch (e) {}
	var __freeze = Object.freeze;
	var __protos = [Object, Array, String, Number, Boolean, Symbol, BigInt, Date, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, Map, Set, WeakMap, WeakSet, ArrayBuffer, DataView, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array];
	for (var __protoIndex = 0; __protoIndex < __protos.length; __protoIndex++) {
		try { __freeze(__protos[__protoIndex].prototype); } catch (e) {}
	}
	try { __freeze(Function.prototype); } catch (e) {}
	try { __freeze(Object.prototype); } catch (e) {}
	var __kill = ["Function", "eval", "WebAssembly", "process", "require", "module", "exports", "global", "Bun", "Deno", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "MessageChannel", "MessagePort", "BroadcastChannel", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame", "structuredClone", "navigator", "window", "document", "self", "importScripts", "Buffer", "Promise", "SharedArrayBuffer", "Atomics", "performance", "crypto", "print", "load", "quit", "exit"];
	for (var __killIndex = 0; __killIndex < __kill.length; __killIndex++) {
		try { delete globalThis[__kill[__killIndex]]; } catch (e) {}
	}
`;

const API_SOURCE = `
	var __logs = [];
	var __tests = [];
	var __variableWrites = [];
	var __headerMutations = [];
	var __failure = null;
	function __stringifyValue(value) {
		if (value === undefined || value === null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "object") {
			try { return __stringify(value); } catch (e) { return "[unserializable]"; }
		}
		return String(value);
	}
	function __truncate(value) {
		var text = __stringifyValue(value);
		return text.length > __limits.textFieldChars ? text.slice(0, __limits.textFieldChars) : text;
	}
	function __describeError(error) {
		if (error && typeof error === "object" && error.__expectation === true) {
			return { code: "EXPECTATION_FAILED", message: String(error.message || "Assertion failed.") };
		}
		var message = error && error.message !== undefined ? String(error.message) : String(error);
		return { code: "SCRIPT_ERROR", message: message || "The script threw an error." };
	}
	function __consoleText(value) {
		if (value === undefined) return "undefined";
		if (value === null) return "null";
		return __stringifyValue(value);
	}
	function __pushLog(level, args) {
		if (__logs.length >= __limits.consoleEntries) return;
		var parts = [];
		for (var index = 0; index < args.length; index++) parts.push(__truncate(__consoleText(args[index])));
		__logs.push({ level: level, message: parts.join(" ") });
	}
	function __expectation(message) {
		var error = new Error(message);
		error.__expectation = true;
		return error;
	}
	function __display(value) {
		try {
			var text = __stringify(value);
			return text === undefined ? String(value) : text;
		} catch (e) {
			return String(value);
		}
	}
	function __deepEqual(left, right) {
		if (left === right) return true;
		if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
		var leftArray = Array.isArray(left);
		var rightArray = Array.isArray(right);
		if (leftArray !== rightArray) return false;
		var leftKeys = Object.keys(left);
		var rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		for (var index = 0; index < leftKeys.length; index++) {
			if (!__hasOwn.call(right, leftKeys[index])) return false;
			if (!__deepEqual(left[leftKeys[index]], right[leftKeys[index]])) return false;
		}
		return true;
	}
	function __pathValue(target, path) {
		var parts = Array.isArray(path) ? path : String(path).split(".");
		var cursor = target;
		for (var index = 0; index < parts.length; index++) {
			if (cursor === null || cursor === undefined) return undefined;
			cursor = cursor[parts[index]];
		}
		return cursor;
	}
	function __matchers(actual) {
		function fail(message) {
			throw __expectation(message);
		}
		return {
			toBe: function (expected) {
				if (actual !== expected) fail("Expected " + __display(expected) + " but received " + __display(actual) + ".");
				return true;
			},
			toEqual: function (expected) {
				if (!__deepEqual(actual, expected)) fail("Expected " + __display(expected) + " but received " + __display(actual) + ".");
				return true;
			},
			toBeTruthy: function () {
				if (!actual) fail("Expected a truthy value but received " + __display(actual) + ".");
				return true;
			},
			toBeFalsy: function () {
				if (actual) fail("Expected a falsy value but received " + __display(actual) + ".");
				return true;
			},
			toBeDefined: function () {
				if (actual === undefined) fail("Expected a defined value.");
				return true;
			},
			toBeNull: function () {
				if (actual !== null) fail("Expected null but received " + __display(actual) + ".");
				return true;
			},
			toContain: function (expected) {
				var contained = typeof actual === "string" ? actual.indexOf(String(expected)) !== -1 : Array.isArray(actual) ? actual.indexOf(expected) !== -1 : false;
				if (!contained) fail("Expected " + __display(actual) + " to contain " + __display(expected) + ".");
				return true;
			},
			toBeGreaterThan: function (expected) {
				if (!(actual > expected)) fail("Expected " + __display(actual) + " to be greater than " + __display(expected) + ".");
				return true;
			},
			toBeLessThan: function (expected) {
				if (!(actual < expected)) fail("Expected " + __display(actual) + " to be less than " + __display(expected) + ".");
				return true;
			},
			toMatch: function (pattern) {
				var regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
				if (!regex.test(String(actual))) fail("Expected " + __display(actual) + " to match " + String(pattern) + ".");
				return true;
			},
			toHaveProperty: function (path, expected) {
				var value = __pathValue(actual, path);
				if (value === undefined) fail("Expected the value to have property " + __display(path) + ".");
				if (arguments.length > 1 && !__deepEqual(value, expected)) fail("Expected property " + __display(path) + " to equal " + __display(expected) + " but received " + __display(value) + ".");
				return true;
			},
		};
	}
	function __registerTest(name, callback) {
		var record = { name: __truncate(name), status: "passed", message: null };
		if (typeof callback !== "function") {
			record.status = "failed";
			record.message = "pm.test requires a callback function.";
		} else {
			try {
				var result = callback();
				if (result && typeof result.then === "function") {
					record.status = "failed";
					record.message = "Async tests are not supported by this sandbox.";
				}
			} catch (error) {
				record.status = "failed";
				record.message = __truncate(error && error.message !== undefined ? error.message : error);
			}
		}
		if (__tests.length < __limits.tests) __tests.push(record);
	}
	function __headerName(input) {
		if (typeof input === "string") return input;
		if (input && typeof input === "object") {
			if (input.name !== undefined) return String(input.name);
			if (input.key !== undefined) return String(input.key);
		}
		return "";
	}
	function __headerValue(input, explicit) {
		if (explicit !== undefined) return explicit;
		if (input && typeof input === "object" && input.value !== undefined) return input.value;
		return "";
	}
	function __pushHeaderMutation(mutation) {
		if (__input.phase !== "prerequest") throw new Error("Request headers can only be changed in a pre-request script.");
		if (__headerMutations.length >= __limits.mutations) throw new Error("The script exceeded the header mutation limit.");
		__headerMutations.push(mutation);
	}
	var __requestHeaders = (__input.request.headers || []).map(function (header) {
		return { name: String(header.name), value: String(header.value) };
	});
	var pmRequestHeaders = {
		get: function (name) {
			var lower = String(name).toLowerCase();
			for (var index = 0; index < __requestHeaders.length; index++) {
				if (__requestHeaders[index].name.toLowerCase() === lower) return __requestHeaders[index].value;
			}
			return null;
		},
		all: function () {
			return __requestHeaders.map(function (header) {
				return { name: header.name, value: header.value };
			});
		},
		add: function (name, value) {
			__pushHeaderMutation({ op: "set", name: __truncate(__headerName(name)), value: __truncate(__headerValue(name, value)) });
		},
		upsert: function (name, value) {
			__pushHeaderMutation({ op: "set", name: __truncate(__headerName(name)), value: __truncate(__headerValue(name, value)) });
		},
		remove: function (name) {
			__pushHeaderMutation({ op: "remove", name: __truncate(__headerName(name)), value: "" });
		},
	};
	var pmRequest = { headers: pmRequestHeaders };
	try {
		Object.defineProperty(pmRequest, "method", {
			enumerable: true,
			get: function () { return __input.request.method; },
			set: function () { throw new Error("Scripts cannot change the request method."); },
		});
		Object.defineProperty(pmRequest, "url", {
			enumerable: true,
			get: function () { return __input.request.url; },
			set: function () { throw new Error("Scripts cannot change the request URL."); },
		});
	} catch (e) {}
	function __readOnlyScope(store) {
		return {
			get: function (name) {
				var key = String(name);
				return __hasOwn.call(store, key) ? store[key] : undefined;
			},
			toObject: function () {
				var copy = {};
				var keys = Object.keys(store);
				for (var index = 0; index < keys.length; index++) copy[keys[index]] = store[keys[index]];
				return copy;
			},
		};
	}
	var __variables = __input.variables;
	var pmVariables = {
		get: function (name) {
			var key = String(name);
			return __hasOwn.call(__variables, key) ? __variables[key] : undefined;
		},
		set: function (name, value) {
			var key = String(name);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Variable names start with a letter or underscore and contain letters, digits, or underscores.");
			if (__variableWrites.length >= __limits.mutations) throw new Error("The script exceeded the variable mutation limit.");
			var text = __stringifyValue(value);
			__variableWrites.push({ op: "set", key: key, value: text });
			__variables[key] = text;
		},
		unset: function (name) {
			var key = String(name);
			if (__variableWrites.length >= __limits.mutations) throw new Error("The script exceeded the variable mutation limit.");
			__variableWrites.push({ op: "unset", key: key, value: "" });
			delete __variables[key];
		},
		toObject: __readOnlyScope(__variables).toObject,
	};
	var pmResponse = null;
	if (__input.response) {
		var __responseBody = __input.response.body;
		var __responseHeaders = __input.response.headers || [];
		pmResponse = {
			code: __input.response.status,
			status: __input.response.status,
			statusText: __input.response.statusText,
			headers: {
				get: function (name) {
					var lower = String(name).toLowerCase();
					for (var index = 0; index < __responseHeaders.length; index++) {
						if (String(__responseHeaders[index].name).toLowerCase() === lower) return __responseHeaders[index].value;
					}
					return null;
				},
				all: function () {
					return __responseHeaders.map(function (header) {
						return { name: header.name, value: header.value };
					});
				},
			},
			text: function () {
				return __responseBody === null || __responseBody === undefined ? "" : __responseBody;
			},
			json: function () {
				if (__responseBody === null || __responseBody === undefined || __responseBody === "") throw new Error("The response body is empty.");
				return __parse(__responseBody);
			},
			truncated: Boolean(__input.response.truncated),
			binary: Boolean(__input.response.binary),
		};
	}
	var __console = {
		log: function () { __pushLog("log", arguments); },
		info: function () { __pushLog("info", arguments); },
		warn: function () { __pushLog("warn", arguments); },
		error: function () { __pushLog("error", arguments); },
		debug: function () { __pushLog("debug", arguments); },
	};
	try {
		Object.defineProperty(globalThis, "console", { value: __console, writable: false, enumerable: false, configurable: false });
	} catch (e) {
		try { globalThis.console = __console; } catch (e2) {}
	}
	var pm = {
		phase: __input.phase,
		variables: pmVariables,
		environment: __readOnlyScope(__input.environment),
		collection: __readOnlyScope(__input.collection),
		request: pmRequest,
		response: pmResponse,
		console: __console,
		expect: function (value) { return __matchers(value); },
		test: __registerTest,
	};
`;

function buildSource(source, input) {
	const payload = JSON.stringify({ ...input, limits: SANDBOX_LIMITS });
	return [
		"(function () {",
		'"use strict";',
		"var __stringify = JSON.stringify;",
		"var __parse = JSON.parse;",
		"var __hasOwn = Object.prototype.hasOwnProperty;",
		HARDENING_SOURCE,
		`var __input = __parse(${JSON.stringify(payload)});`,
		"var __limits = __input.limits;",
		API_SOURCE,
		"try {",
		"(function () {",
		String(source ?? ""),
		"}).call(undefined);",
		"} catch (__error) { __failure = __describeError(__error); }",
		"return __stringify({ console: __logs, tests: __tests, variables: __variableWrites, headers: __headerMutations, error: __failure });",
		"})()",
	].join("\n");
}

function trimText(value, maxBytes) {
	const text = typeof value === "string" ? value : "";
	if (utf8Bytes(text) <= maxBytes) return text;
	return text.slice(0, maxBytes);
}

export function normalizeSandboxOutput(value) {
	const output = { console: [], tests: [], variables: [], headers: [] };
	if (!value || typeof value !== "object") return output;
	if (Array.isArray(value.console)) {
		for (const entry of value.console.slice(0, LIMITS.scriptConsoleEntries)) {
			if (!entry || typeof entry !== "object") continue;
			const level = CONSOLE_LEVELS.has(entry.level) ? entry.level : "log";
			output.console.push({ level, message: trimText(entry.message, LIMITS.scriptTextFieldBytes) });
		}
	}
	if (Array.isArray(value.tests)) {
		for (const entry of value.tests.slice(0, LIMITS.scriptTests)) {
			if (!entry || typeof entry !== "object") continue;
			const status = TEST_STATUSES.has(entry.status) ? entry.status : "failed";
			output.tests.push({
				name: trimText(entry.name, 200),
				status,
				message: entry.message === null || entry.message === undefined ? null : trimText(entry.message, LIMITS.scriptTextFieldBytes),
			});
		}
	}
	if (Array.isArray(value.variables)) {
		for (const entry of value.variables.slice(0, LIMITS.scriptMutations)) {
			if (!entry || typeof entry !== "object") continue;
			const op = entry.op === "unset" ? "unset" : "set";
			output.variables.push({ op, key: trimText(entry.key, 128), value: trimText(entry.value, LIMITS.variableValueBytes) });
		}
	}
	if (Array.isArray(value.headers)) {
		for (const entry of value.headers.slice(0, LIMITS.scriptMutations)) {
			if (!entry || typeof entry !== "object") continue;
			const op = entry.op === "remove" ? "remove" : "set";
			output.headers.push({ op, name: trimText(entry.name, 512), value: trimText(entry.value, LIMITS.rowValueBytes) });
		}
	}
	return output;
}

export function classifySandboxError(error) {
	const message = error?.message !== undefined ? String(error.message) : String(error ?? "Sandbox failure.");
	if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(message)) {
		return { code: "SCRIPT_TIMEOUT", message: `The script exceeded its ${SANDBOX_LIMITS.timeoutMs} ms execution budget.` };
	}
	if (error?.name === "SyntaxError" || error instanceof SyntaxError) {
		return { code: "SCRIPT_SYNTAX_ERROR", message: `The script could not be compiled: ${message}` };
	}
	return { code: "SCRIPT_ERROR", message };
}

export function runSandboxedScript({ source, phase, input }) {
	const text = String(source ?? "");
	if (!text.trim()) return { ok: true, error: null, output: normalizeSandboxOutput(null) };
	if (utf8Bytes(text) > LIMITS.scriptSourceBytes) {
		return {
			ok: false,
			error: { code: "SCRIPT_TOO_LARGE", message: `Scripts are limited to ${Math.round(LIMITS.scriptSourceBytes / 1024)} KiB.` },
		};
	}
	const forbidden = scanForbiddenTokens(text);
	if (forbidden) {
		return {
			ok: false,
			error: {
				code: "SCRIPT_FORBIDDEN_API",
				message: `The sandbox does not allow "${forbidden.token}" (line ${forbidden.line}).`,
				details: { token: forbidden.token, line: forbidden.line },
			},
		};
	}
	let raw;
	try {
		const context = vm.createContext(Object.create(null), { name: `tracer-script-${phase}`, codeGeneration: { strings: false, wasm: false } });
		raw = vm.runInContext(buildSource(text, input), context, {
			timeout: SANDBOX_LIMITS.timeoutMs,
			filename: `tracer-script-${phase}.js`,
			displayErrors: true,
		});
	} catch (error) {
		return { ok: false, error: classifySandboxError(error) };
	}
	if (typeof raw !== "string" || utf8Bytes(raw) > LIMITS.scriptOutputBytes) {
		return { ok: false, error: { code: "SCRIPT_OUTPUT_LIMIT", message: "The script produced more output than the sandbox allows." } };
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: { code: "SANDBOX_CRASH", message: "The script runtime ended unexpectedly and its changes were discarded." } };
	}
	const output = normalizeSandboxOutput(parsed);
	const error = parsed?.error && typeof parsed.error === "object" ? { code: String(parsed.error.code ?? "SCRIPT_ERROR"), message: trimText(parsed.error.message, LIMITS.scriptTextFieldBytes) } : null;
	return { ok: true, error, output };
}

export { SANDBOX_LIMITS };
