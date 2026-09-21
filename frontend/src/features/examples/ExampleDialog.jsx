import { useState } from "react";
import { Modal } from "../../shared/components/Modal.jsx";
import { KeyValueEditor } from "../requests/KeyValueEditor.jsx";
import {
	EXAMPLE_METHODS,
	cleanMatch,
	cleanResponse,
	exampleDraft,
	fromResponseInput,
	manualInput,
	responsePayloadFrom,
	selectableRequestRows,
	updateInput,
} from "./example-draft.js";

function ResponseSummary({ result }) {
	const payload = responsePayloadFrom(result);
	if (!payload) return <p className="field-hint">Send this request first to save its response as an example.</p>;
	const bytes = new TextEncoder().encode(payload.body.value ?? "").length;
	return (
		<ul className="example-summary">
			<li>
				Status <strong>{payload.status}</strong> {payload.statusText}
			</li>
			<li>
				Content type <strong>{payload.contentType || "—"}</strong>
			</li>
			<li>
				Headers <strong>{payload.headers.length}</strong>
			</li>
			<li>
				Body <strong>{bytes}</strong> bytes{payload.body.encoding === "base64" ? " (binary)" : ""}
				{payload.body.truncated ? " · truncated when saved" : ""}
			</li>
		</ul>
	);
}

function RuleSelection({ label, rows, selected, onToggle }) {
	if (rows.length === 0) return <p className="field-hint">This request has no enabled {label}.</p>;
	return (
		<fieldset className="example-selection">
			<legend>{label}</legend>
			{rows.map((row) => (
				<label className="kv-check" key={row.id}>
					<input checked={selected.includes(row.id)} type="checkbox" onChange={() => onToggle(row.id)} />
					<span>
						<strong>{row.key}</strong>
						{row.value ? `: ${row.value}` : ""}
					</span>
				</label>
			))}
		</fieldset>
	);
}

export function ExampleDialog({
	busy = false,
	collectionId = null,
	environmentId = null,
	error = "",
	example = null,
	mode,
	onCancel,
	onSubmit,
	request = null,
	result = null,
}) {
	const editing = mode === "edit";
	const fromResponse = mode === "from-response";
	const initial = exampleDraft(example);
	const [name, setName] = useState(fromResponse ? `${request?.name ?? "Request"} response` : initial.name);
	const [match, setMatch] = useState(() => (fromResponse ? { method: request?.method ?? "GET", path: "", query: [], headers: [] } : initial.match));
	const [response, setResponse] = useState(() => initial.response);
	const selectable = selectableRequestRows(request);
	const [selectedQuery, setSelectedQuery] = useState(() => selectable.query.map((row) => row.id));
	const [selectedHeaders, setSelectedHeaders] = useState(() => selectable.headers.map((row) => row.id));
	const [bodyText, setBodyText] = useState(() => (fromResponse ? (responsePayloadFrom(result)?.body.value ?? "") : initial.response.body.value));
	const [bodyEncoding, setBodyEncoding] = useState(() => (fromResponse ? (responsePayloadFrom(result)?.body.encoding ?? "utf8") : initial.response.body.encoding));
	const [bodyMediaType, setBodyMediaType] = useState(() => (fromResponse ? (responsePayloadFrom(result)?.body.mediaType ?? "") : initial.response.body.mediaType));

	const toggle = (list, setList) => (id) => setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

	const submit = () => {
		if (fromResponse) {
			onSubmit(
				fromResponseInput({
					name: name.trim(),
					request,
					result,
					environmentId,
					source: { collectionId },
					selectQueryIds: selectedQuery,
					selectHeaderIds: selectedHeaders,
				}),
			);
			return;
		}
		const payload = {
			name: name.trim(),
			match: cleanMatch(match),
			response: cleanResponse({
				...response,
				body: { encoding: bodyEncoding, value: bodyText, mediaType: bodyMediaType, truncated: false, omittedReason: null },
			}),
		};
		onSubmit(editing ? updateInput(payload) : manualInput(payload));
	};

	return (
		<Modal className="form-dialog-modal" label={editing ? "Edit example" : "New example"} onClose={() => !busy && onCancel()}>
			<section className="form-dialog example-dialog">
				<h2>{editing ? "Edit example" : fromResponse ? "Save as example" : "New example"}</h2>
				<div className="form-dialog-body">
					<div className="field-row">
						<label htmlFor="example-name">Name</label>
						<input
							data-autofocus
							id="example-name"
							maxLength={80}
							placeholder="Orders — paid"
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					{fromResponse ? (
						<>
							<div className="field-row">
								<span className="field-label">Response</span>
								<ResponseSummary result={result} />
							</div>
							<RuleSelection label="query parameters" rows={selectable.query} selected={selectedQuery} onToggle={toggle(selectedQuery, setSelectedQuery)} />
							<RuleSelection label="headers" rows={selectable.headers} selected={selectedHeaders} onToggle={toggle(selectedHeaders, setSelectedHeaders)} />
							<p className="field-hint">
								Selected rows become the mock match rules. Credential headers are never used as rules. The response is copied from this
								send; the execution receipt is left untouched.
							</p>
						</>
					) : (
						<>
							<div className="field-row">
								<label htmlFor="example-method">Match method</label>
								<select id="example-method" value={match.method} onChange={(event) => setMatch({ ...match, method: event.target.value })}>
									{EXAMPLE_METHODS.map((method) => (
										<option key={method} value={method}>
											{method}
										</option>
									))}
								</select>
							</div>
							<div className="field-row">
								<label htmlFor="example-path">Match path</label>
								<input
									id="example-path"
									placeholder="/orders"
									type="text"
									value={match.path}
									onChange={(event) => setMatch({ ...match, path: event.target.value })}
								/>
							</div>
							<KeyValueEditor
								keyPlaceholder="Parameter"
								label="Match query parameters"
								rows={match.query}
								onChange={(rows) => setMatch({ ...match, query: rows })}
							/>
							<KeyValueEditor
								keyPlaceholder="Header"
								label="Match headers"
								rows={match.headers}
								onChange={(rows) => setMatch({ ...match, headers: rows })}
							/>
							<div className="field-row">
								<label htmlFor="example-status">Response status</label>
								<input
									id="example-status"
									max={599}
									min={100}
									type="number"
									value={response.status}
									onChange={(event) => setResponse({ ...response, status: event.target.value })}
								/>
								<input
									aria-label="Response status text"
									maxLength={120}
									placeholder="OK"
									type="text"
									value={response.statusText}
									onChange={(event) => setResponse({ ...response, statusText: event.target.value })}
								/>
							</div>
							<div className="field-row">
								<label htmlFor="example-content-type">Content type</label>
								<input
									id="example-content-type"
									placeholder="application/json"
									type="text"
									value={response.contentType}
									onChange={(event) => setResponse({ ...response, contentType: event.target.value })}
								/>
							</div>
							<KeyValueEditor
								keyPlaceholder="Header"
								label="Response headers"
								rows={response.headers}
								onChange={(rows) => setResponse({ ...response, headers: rows })}
							/>
							<div className="field-row">
								<label htmlFor="example-encoding">Body</label>
								<select id="example-encoding" value={bodyEncoding} onChange={(event) => setBodyEncoding(event.target.value)}>
									<option value="utf8">Text</option>
									<option value="base64">Base64 (binary)</option>
								</select>
								<input
									aria-label="Body media type"
									placeholder="application/json"
									type="text"
									value={bodyMediaType}
									onChange={(event) => setBodyMediaType(event.target.value)}
								/>
							</div>
							<textarea
								aria-label="Response body"
								className="example-body-input"
								placeholder={bodyEncoding === "base64" ? "AAECAw==" : '{"orders":[]}'}
								rows={5}
								value={bodyText}
								onChange={(event) => setBodyText(event.target.value)}
							/>
							<p className="field-hint">
								Mock Send matches the request method, path, and the rows above. Credential headers are rejected as match rules.
							</p>
						</>
					)}
					{error && (
						<p className="dialog-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<footer>
					<button className="text-button" disabled={busy} type="button" onClick={onCancel}>
						Cancel
					</button>
					<button className="primary-button" disabled={busy || !name.trim()} type="button" onClick={submit}>
						{busy ? "Saving…" : editing ? "Save changes" : "Save example"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}
