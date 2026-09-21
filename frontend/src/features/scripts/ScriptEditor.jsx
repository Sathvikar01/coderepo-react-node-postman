const GUIDES = {
	preRequest: {
		label: "Pre-request script",
		hint: "Runs before the draft is compiled. Only request headers and variables can be changed here; the request still passes the normal compiler, target policy, DNS, and transport.",
		api: [
			"pm.variables.get(name) / set(name, value) / unset(name)",
			"pm.environment.get(name) and pm.collection.get(name) are read-only",
			"pm.request.headers.add({ name, value }), .upsert(...), .remove(name), .get(name), .all()",
			"pm.console.log(value, ...) captures bounded console output",
		],
		snippet: 'pm.variables.set("host", "api.example.test");\npm.request.headers.add("X-Trace", "1");',
	},
	test: {
		label: "Tests",
		hint: "Runs after a response arrives. The script can read the response but cannot change the sent request or the stored HTTP result.",
		api: [
			'pm.test("name", function () { ... }) records a pass or fail',
			"pm.expect(value).toBe / toEqual / toBeTruthy / toContain / toMatch / toHaveProperty ...",
			"pm.response.code, pm.response.headers.get(name), pm.response.json(), pm.response.text()",
			"pm.console.log(value, ...) captures bounded console output",
		],
		snippet: 'pm.test("status is 200", function () {\n\tpm.expect(pm.response.code).toBe(200);\n});',
	},
};

export function ScriptEditor({ kind, value, onChange }) {
	const guide = GUIDES[kind];
	return (
		<div className="script-editor">
			<p className="field-hint">{guide.hint}</p>
			<textarea
				aria-label={guide.label}
				className="script-textarea"
				placeholder={guide.snippet}
				spellCheck="false"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<details className="script-reference">
				<summary>Script API</summary>
				<ul className="script-hints">
					{guide.api.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
				<p className="field-hint">
					Scripts are synchronous and sandboxed: no network, filesystem, process, timers, imports, or prototype access. A script that
					fails or times out is reported separately from the HTTP result.
				</p>
			</details>
		</div>
	);
}
