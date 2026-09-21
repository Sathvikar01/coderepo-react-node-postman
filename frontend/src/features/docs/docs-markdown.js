// Static Markdown export for the generated documentation model.
//
// The export is deterministic: it depends only on the model, never on the clock, the
// DOM, or the network. Text is escaped for Markdown contexts so a saved name, header,
// or body can never turn into live HTML in a viewer that renders raw markup, and every
// fenced block picks a fence longer than the longest backtick run it contains so a body
// cannot escape its own code block. Content inside a fence is never rewritten.

const EMPTY = "\u2014";
const NOTICE_PREFIX = "> ";

const escapeProse = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const escapeCell = (value) => escapeProse(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function fenceFor(value) {
	const runs = String(value ?? "").match(/`+/g) ?? [];
	const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
	return "`".repeat(Math.max(3, longest + 1));
}

function block(value, language = "text") {
	const text = String(value ?? "");
	const fence = fenceFor(text);
	return [`${fence}${language}`, text, fence, ""];
}

function table(headers, rows) {
	const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
	for (const row of rows) lines.push(`| ${row.map(escapeCell).join(" | ")} |`);
	lines.push("");
	return lines;
}

function bullets(entries) {
	return entries.map((entry) => `- ${entry}`).join("\n");
}

function requestVariablesSection(request) {
	if (request.variables.length === 0) return [];
	const entries = request.variables.map((entry) => `\`{{${entry.name}}}\` \u00b7 ${escapeProse(entry.label)}`);
	return ["**Variables**", "", bullets(entries), ""];
}

function examplesSection(request) {
	if (request.examples.length === 0) return [];
	const lines = ["**Response examples**", ""];
	for (const example of request.examples) {
		const status = example.status === null ? "" : ` \u00b7 ${example.status}`;
		lines.push(`*${escapeProse(example.name)}${status}*`, "");
		if (example.headers.length > 0)
			lines.push(
				...table(
					["Header", "Value"],
					example.headers.map((header) => [header.name, header.value]),
				),
			);
		if (example.body) {
			lines.push(...block(example.body));
			if (example.bodyTruncated) lines.push(`${NOTICE_PREFIX}(Body shortened for this export.)`, "");
		}
	}
	return lines;
}

function requestDocsLines(request) {
	const lines = [`### ${escapeProse(request.method)} ${escapeProse(request.url)}`, "", `_${escapeProse(request.name)}_`, ""];
	if (request.urlTruncated) lines.push(`${NOTICE_PREFIX}(The URL was shortened for this export.)`, "");
	if (request.description) lines.push(escapeProse(request.description), "");
	const authNote = request.auth.inherited ? " (inherited from the collection)" : "";
	lines.push(`**Auth:** ${escapeProse(request.auth.label)}${authNote}`, "");
	if (request.auth.fields.length > 0)
		lines.push(
			...table(
				["Field", "Value"],
				request.auth.fields.map((field) => [field.label, field.text || EMPTY]),
			),
		);
	if (request.query.length > 0)
		lines.push(
			"**Query parameters**",
			"",
			...table(
				["Name", "Value", "Enabled"],
				request.query.map((row) => [row.key, row.value, row.enabled ? "yes" : "no"]),
			),
		);
	if (request.headers.length > 0)
		lines.push(
			"**Headers**",
			"",
			...table(
				["Name", "Value", "Enabled"],
				request.headers.map((row) => [row.key, row.value, row.enabled ? "yes" : "no"]),
			),
		);
	if (request.body.mode === "urlencoded" && request.body.rows.length > 0)
		lines.push(
			"**Body (_application/x-www-form-urlencoded_)**",
			"",
			...table(
				["Field", "Value", "Enabled"],
				request.body.rows.map((row) => [row.key, row.value, row.enabled ? "yes" : "no"]),
			),
		);
	else if (request.body.text) {
		const json = request.body.mode === "json";
		const label = json ? "application/json" : escapeProse(request.body.contentType || "text/plain");
		lines.push(`**Body (_${label}_)**`, "", ...block(request.body.text, json ? "json" : "text"));
	}
	for (const notice of request.body.notices) lines.push(`${NOTICE_PREFIX}${escapeProse(notice)}`, "");
	lines.push(...requestVariablesSection(request));
	lines.push(...examplesSection(request));
	return lines;
}

export function requestDocsToMarkdown(request) {
	return `${requestDocsLines(request).join("\n").trimEnd()}\n`;
}

export function collectionDocsToMarkdown(model) {
	const lines = [`# ${escapeProse(model.name)}`, ""];
	if (model.description) lines.push(escapeProse(model.description), "");
	const meta = [];
	if (model.revision !== null) meta.push(`Saved revision ${model.revision}`);
	meta.push(`${model.requestCount} request${model.requestCount === 1 ? "" : "s"}`);
	lines.push(`_${meta.join(" \u00b7 ")}_`, "");
	if (model.variables.length > 0) {
		lines.push(
			"## Variables",
			"",
			...table(
				["Name", "Source", "Status", "Used by"],
				model.variables.map((entry) => [
					`{{${entry.key}}}`,
					entry.label,
					entry.declared ? (entry.enabled ? "enabled" : "disabled") : EMPTY,
					entry.usedByCount === 0 ? "not referenced" : `${entry.usedByCount} request${entry.usedByCount === 1 ? "" : "s"}`,
				]),
			),
			"_Values are never included in generated documentation._",
			"",
		);
	}
	if (model.requests.length === 0) lines.push("_This collection has no saved requests._", "");
	let group = null;
	for (const request of model.requests) {
		if (request.group.id !== group?.id) {
			group = request.group;
			lines.push(`## ${escapeProse(group.name)}`, "");
		}
		lines.push(...requestDocsLines(request), "");
	}
	if (model.overflow > 0) lines.push(`_${model.overflow} further request(s) are not included in this view._`, "");
	return `${lines.join("\n").trimEnd()}\n`;
}

const UNSAFE_FILENAME = /[^A-Za-z0-9._ -]+/g;

export function collectionDocsFileName(name) {
	const base = String(name ?? "")
		.trim()
		.replace(UNSAFE_FILENAME, "-")
		.replace(/[\s.]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${base ? base.toLowerCase() : "collection"}-docs.md`;
}
