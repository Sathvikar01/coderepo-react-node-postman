// Request to code. Renders the normalized export model as a copy-pasteable
// snippet for cURL, browser/Node fetch, Node's http client, or Python requests.
//
// The renderers never resolve variables: whatever `{{reference}}` the request
// holds is printed as a placeholder the reader substitutes.

import { buildExportModel } from "./request-export-model.js";

export const SNIPPET_FORMATS = [
	{ value: "curl", label: "cURL" },
	{ value: "javascript", label: "JavaScript (fetch)" },
	{ value: "node", label: "Node.js (http)" },
	{ value: "python", label: "Python (requests)" },
];

function jsString(value) {
	return JSON.stringify(String(value))
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Black-style quotes: prefer double quotes, fall back to single quotes when the
// text contains a double quote but no single quote.
function pythonString(value) {
	const text = String(value);
	const quote = text.includes('"') && !text.includes("'") ? "'" : '"';
	const escaped = text
		.replace(/\\/g, "\\\\")
		.replace(new RegExp(quote, "g"), `\\${quote}`)
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return `${quote}${escaped}${quote}`;
}

function renderCurl(model) {
	// curl performs URL globbing on braces, so a URL holding a `{{reference}}`
	// must be fetched with globbing off.
	const globoff = /[{}]/.test(model.url) ? " --globoff" : "";
	const parts = [`curl${globoff} --request ${model.method}`, `  --url ${shellQuote(model.url)}`];
	for (const header of model.headers) parts.push(`  --header ${shellQuote(`${header.name}: ${header.value}`)}`);
	if (model.basicAuth) parts.push(`  --user ${shellQuote(`${model.basicAuth.username}:${model.basicAuth.password}`)}`);
	if (model.body.kind === "raw") parts.push(`  --data-raw ${shellQuote(model.body.text)}`);
	if (model.body.kind === "urlencoded")
		for (const [key, value] of model.body.pairs) parts.push(`  --data-urlencode ${shellQuote(`${key}=${value}`)}`);
	return parts.join(" \\\n");
}

function basicHeaderExpression(model, encode) {
	if (!model.basicAuth) return null;
	const credentials = jsString(`${model.basicAuth.username}:${model.basicAuth.password}`);
	return `"Basic " + ${encode(credentials)}`;
}

function renderJavascript(model) {
	const headerPairs = model.headers.map((header) => [jsString(header.name), jsString(header.value)]);
	const authorization = basicHeaderExpression(model, (credentials) => `btoa(${credentials})`);
	if (authorization) headerPairs.push([jsString("Authorization"), authorization]);
	const names = new Set();
	const repeated = new Set();
	for (const header of model.headers) {
		const key = header.name.toLowerCase();
		if (names.has(key)) repeated.add(header.name);
		names.add(key);
	}
	const options = [`  method: ${jsString(model.method)},`];
	if (headerPairs.length > 0) {
		options.push("  headers: [");
		for (const [name, value] of headerPairs) options.push(`    [${name}, ${value}],`);
		options.push("  ],");
	}
	if (model.body.kind === "raw") options.push(`  body: ${jsString(model.body.text)},`);
	if (model.body.kind === "urlencoded") {
		options.push("  body: new URLSearchParams([");
		for (const [key, value] of model.body.pairs) options.push(`    [${jsString(key)}, ${jsString(value)}],`);
		options.push("  ]),");
	}
	const lines = [];
	if (repeated.size > 0)
		lines.push(`// Note: fetch sends the repeated header names (${[...repeated].join(", ")}) as one comma-separated header.`);
	lines.push(
		`const response = await fetch(${jsString(model.url)}, {`,
		...options,
		"});",
		"console.log(response.status, await response.text());",
	);
	return lines.join("\n");
}

function nodeHeaderValue(values) {
	return values.length === 1 ? jsString(values[0]) : `[${values.map((value) => jsString(value)).join(", ")}]`;
}

function renderNode(model) {
	const grouped = new Map();
	for (const header of model.headers) {
		const key = header.name;
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(header.value);
	}
	const authorization = basicHeaderExpression(model, (credentials) => `Buffer.from(${credentials}).toString("base64")`);
	if (authorization) grouped.set("Authorization", [null]);
	// Explicit Content-Length keeps DELETE (and every other method) framed
	// correctly; without it Node writes an unframed body for some methods.
	if (model.body.kind === "raw") grouped.set("Content-Length", [String(new TextEncoder().encode(model.body.text).length)]);
	if (model.body.kind === "urlencoded") grouped.set("Content-Length", [String(new URLSearchParams(model.body.pairs).toString().length)]);
	const lines = [
		'import http from "node:http";',
		'import https from "node:https";',
		"",
		`const url = ${jsString(model.url)};`,
		'const client = url.startsWith("https:") ? https : http;',
	];
	if (model.body.kind === "urlencoded") {
		lines.push("", "const body = new URLSearchParams([");
		for (const [key, value] of model.body.pairs) lines.push(`  [${jsString(key)}, ${jsString(value)}],`);
		lines.push("]).toString();");
	}
	lines.push("", "const request = client.request(", "  url,", "  {", `    method: ${jsString(model.method)},`);
	const headerEntries = [...grouped.entries()];
	if (headerEntries.length > 0) {
		lines.push("    headers: {");
		for (const [name, values] of headerEntries) {
			if (values.length === 1 && values[0] === null) lines.push(`      ${jsString(name)}: ${authorization},`);
			else if (name.toLowerCase() === "content-length") lines.push(`      ${jsString(name)}: ${values[0]},`);
			else lines.push(`      ${jsString(name)}: ${nodeHeaderValue(values)},`);
		}
		lines.push("    },");
	}
	lines.push(
		"  },",
		"  (response) => {",
		'    let data = "";',
		'    response.setEncoding("utf8");',
		'    response.on("data", (chunk) => (data += chunk));',
		'    response.on("end", () => console.log(response.statusCode, data));',
		"  },",
		");",
	);
	if (model.body.kind === "raw") lines.push("", `request.write(${jsString(model.body.text)});`);
	if (model.body.kind === "urlencoded") lines.push("", "request.write(body);");
	lines.push("", "request.end();");
	return lines.join("\n");
}

function renderPython(model) {
	const lines = ["import requests"];
	// requests only accepts a mapping for headers, so repeated names are joined
	// into one comma-separated value instead of being dropped.
	const merged = new Map();
	const repeated = new Set();
	for (const header of model.headers) {
		const key = header.name.toLowerCase();
		if (merged.has(key)) {
			repeated.add(header.name);
			merged.get(key).value = `${merged.get(key).value}, ${header.value}`;
		} else {
			merged.set(key, { name: header.name, value: header.value });
		}
	}
	if (repeated.size > 0)
		lines.push(
			`# Note: Python requests combines the repeated header names (${[...repeated].join(", ")}) into one comma-separated header.`,
		);
	lines.push("", "response = requests.request(", `    ${pythonString(model.method)},`, `    ${pythonString(model.url)},`);
	if (merged.size > 0) {
		lines.push("    headers={");
		for (const header of merged.values()) lines.push(`        ${pythonString(header.name)}: ${pythonString(header.value)},`);
		lines.push("    },");
	}
	if (model.basicAuth) lines.push(`    auth=(${pythonString(model.basicAuth.username)}, ${pythonString(model.basicAuth.password)}),`);
	if (model.body.kind === "raw") lines.push(`    data=${pythonString(model.body.text)},`);
	if (model.body.kind === "urlencoded") {
		lines.push("    data=[");
		for (const [key, value] of model.body.pairs) lines.push(`        (${pythonString(key)}, ${pythonString(value)}),`);
		lines.push("    ],");
	}
	lines.push(")", "print(response.status_code, response.text)");
	return lines.join("\n");
}

const RENDERERS = {
	curl: renderCurl,
	javascript: renderJavascript,
	node: renderNode,
	python: renderPython,
};

export function generateSnippet(request, format, options = {}) {
	const selected = SNIPPET_FORMATS.find((item) => item.value === format);
	if (!selected)
		return {
			ok: false,
			format,
			label: "",
			code: "",
			errors: [
				{
					code: "FORMAT_UNSUPPORTED",
					message: `Tracer generates ${SNIPPET_FORMATS.map((item) => item.label).join(", ")} snippets; "${format}" is not supported.`,
				},
			],
			warnings: [],
		};

	const built = buildExportModel(request, options);
	if (!built.ok)
		return {
			ok: false,
			format,
			label: selected.label,
			code: "",
			errors: built.errors,
			warnings: built.warnings,
		};
	return {
		ok: true,
		format,
		label: selected.label,
		code: RENDERERS[format](built.model),
		errors: [],
		warnings: built.warnings,
	};
}
