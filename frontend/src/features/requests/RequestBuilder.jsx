import { useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { ScriptEditor } from "../scripts/ScriptEditor.jsx";
import { KeyValueEditor } from "./KeyValueEditor.jsx";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const BODY_MODES = [
	{ value: "none", label: "None" },
	{ value: "json", label: "JSON" },
	{ value: "text", label: "Text" },
	{ value: "urlencoded", label: "Form URL encoded" },
];
const AUTH_MODES = [
	{ value: "inherit", label: "Inherit from collection" },
	{ value: "none", label: "No auth" },
	{ value: "bearer", label: "Bearer token" },
	{ value: "basic", label: "Basic auth" },
	{ value: "apiKey", label: "API key" },
];

const countEnabled = (rows = []) => rows.filter((row) => row.enabled && row.key.trim()).length;

function AuthEditor({ auth, authOverride, collectionAuth, onAuthChange, onOverrideChange }) {
	const [sendOnly, setSendOnly] = useState(Boolean(authOverride));
	const saved = auth ?? { mode: "none" };
	const effective = sendOnly ? (authOverride ?? { mode: "none" }) : saved;
	const mode = effective.mode ?? "none";

	const defaultAuth = (nextMode) =>
		nextMode === "bearer"
			? { mode: "bearer", tokenTemplate: "" }
			: nextMode === "basic"
				? { mode: "basic", usernameTemplate: "", passwordTemplate: "" }
				: nextMode === "apiKey"
					? { mode: "apiKey", key: "", valueTemplate: "", in: "header" }
					: nextMode === "inherit"
						? { mode: "inherit" }
						: { mode: "none" };

	const commit = (next) => (sendOnly ? onOverrideChange(next) : onAuthChange(next));
	const setMode = (nextMode) => commit(defaultAuth(nextMode));
	const update = (patch) => commit({ ...effective, ...patch });
	const inheritSource = saved.mode === "inherit" ? collectionAuth : null;

	return (
		<div className="settings-grid">
			<div className="field-row">
				<label htmlFor="auth-mode">Authentication</label>
				<SelectMenu ariaLabel="Authentication mode" options={AUTH_MODES} value={mode} onChange={setMode} />
			</div>
			<div>
				<button
					className="text-button"
					type="button"
					onClick={() => {
						if (sendOnly) {
							setSendOnly(false);
							onOverrideChange(null);
						} else {
							setSendOnly(true);
							onOverrideChange({ mode: "none" });
						}
					}}
				>
					{sendOnly ? "Edit saved authentication" : "Use a send-only override"}
				</button>
			</div>
			{!sendOnly && mode === "inherit" && (
				<p className="field-hint">
					{inheritSource
						? `Inherited from the collection: ${inheritSource.mode === "none" ? "no authentication" : inheritSource.mode}.`
						: "Attach this request to a collection to inherit its authentication."}
				</p>
			)}
			{mode === "bearer" && (
				<div className="field-row">
					<label htmlFor="auth-token">Token</label>
					<input id="auth-token" placeholder="{{orders_token}}" type="text" value={effective.tokenTemplate ?? ""} onChange={(event) => update({ tokenTemplate: event.target.value })} />
				</div>
			)}
			{mode === "basic" && (
				<>
					<div className="field-row">
						<label htmlFor="auth-username">Username</label>
						<input id="auth-username" type="text" value={effective.usernameTemplate ?? ""} onChange={(event) => update({ usernameTemplate: event.target.value })} />
					</div>
					<div className="field-row">
						<label htmlFor="auth-password">Password</label>
						<input id="auth-password" type="text" value={effective.passwordTemplate ?? ""} onChange={(event) => update({ passwordTemplate: event.target.value })} />
					</div>
				</>
			)}
			{mode === "apiKey" && (
				<>
					<div className="field-row">
						<label htmlFor="auth-key">Key name</label>
						<input id="auth-key" type="text" value={effective.key ?? ""} onChange={(event) => update({ key: event.target.value })} />
					</div>
					<div className="field-row">
						<label htmlFor="auth-value">Value</label>
						<input id="auth-value" type="text" value={effective.valueTemplate ?? ""} onChange={(event) => update({ valueTemplate: event.target.value })} />
					</div>
					<div className="field-row">
						<label htmlFor="auth-in">Add to</label>
						<SelectMenu ariaLabel="Where to add the API key" options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]} value={effective.in ?? "header"} onChange={(value) => update({ in: value })} />
					</div>
				</>
			)}
			<p className="field-hint">
				{sendOnly
					? "This override applies to the next send only and is never saved."
					: "Saved credential fields must use variable references such as {{orders_token}}."}
			</p>
		</div>
	);
}

function BodyEditor({ body, onChange }) {
	const update = (patch) => onChange({ ...body, ...patch });
	const changeMode = (mode) => {
		if (mode === "none") return onChange({ mode: "none" });
		if (mode === "json") return onChange({ mode: "json", text: body.mode === "json" ? (body.text ?? "") : "{\n  \n}" });
		if (mode === "text")
			return onChange({ mode: "text", text: body.mode === "text" ? (body.text ?? "") : "", contentType: "text/plain" });
		return onChange({ mode: "urlencoded", rows: body.mode === "urlencoded" ? (body.rows ?? []) : [] });
	};
	return (
		<div className="raw-editor">
			<div className="field-row">
				<label htmlFor="body-mode">Body type</label>
				<SelectMenu
					ariaLabel="Body type"
					options={BODY_MODES}
					value={body.mode}
					onChange={changeMode}
				/>
			</div>
			{body.mode === "none" && (
				<p className="field-hint">This request is sent without a body. GET and HEAD requests never include one.</p>
			)}
			{(body.mode === "json" || body.mode === "text") && (
				<>
					<textarea
						aria-label={body.mode === "json" ? "JSON body" : "Text body"}
						spellCheck="false"
						value={body.text ?? ""}
						onChange={(event) => update({ text: event.target.value })}
					/>
					{body.mode === "json" && (
						<p className="field-hint">
							Variables are interpolated literally. Numeric values can replace an unquoted placeholder; strings containing
							quotes or line breaks must be escaped by you. The JSON is validated after interpolation.
						</p>
					)}
					{body.mode === "text" && (
						<div className="field-row">
							<label htmlFor="body-content-type">Content type</label>
							<input
								id="body-content-type"
								type="text"
								value={body.contentType ?? "text/plain"}
								onChange={(event) => update({ contentType: event.target.value })}
							/>
						</div>
					)}
				</>
			)}
			{body.mode === "urlencoded" && (
				<KeyValueEditor label="Form fields" rows={body.rows ?? []} onChange={(rows) => update({ rows })} keyPlaceholder="Field" />
			)}
		</div>
	);
}

export function RequestBuilder({
	authOverride,
	collectionAuth,
	draftVersion,
	environments,
	executionPolicy,
	hasCollection,
	onCancel,
	onChange,
	onExport,
	onOverrideChange,
	onSave,
	onSend,
	request,
	running,
	savedName,
}) {
	const [section, setSection] = useState("params");
	const tabs = useRovingTabs();
	const disabledBody = ["GET", "HEAD"].includes(request.method);
	const timeoutBounds = { min: executionPolicy?.minTimeoutMs ?? 100, max: executionPolicy?.maxTimeoutMs ?? 30000 };
	const sections = [
		{ id: "params", label: "Params", badge: countEnabled(request.query) },
		{ id: "headers", label: "Headers", badge: countEnabled(request.headers) },
		{ id: "body", label: "Body", badge: request.body.mode === "none" ? 0 : 1 },
		{ id: "auth", label: "Auth", badge: request.auth.mode === "inherit" ? 0 : 1 },
		{ id: "preRequest", label: "Pre-request", badge: request.scripts?.preRequest?.trim() ? 1 : 0 },
		{ id: "tests", label: "Tests", badge: request.scripts?.test?.trim() ? 1 : 0 },
		{ id: "settings", label: "Settings", badge: 0 },
	];
	return (
		<section aria-label="Request builder" className="request-builder">
			<div className="request-title-row">
				<input
					aria-label="Request name"
					className="request-name-input"
					placeholder="Request name"
					type="text"
					value={request.name}
					onChange={(event) => onChange({ name: event.target.value })}
				/>
				{savedName && <span className="field-hint">Saved in {savedName}</span>}
				<button className="button" type="button" onClick={onSave}>
					<MaterialIcon size={18}>save</MaterialIcon>
					<span className="button-label">Save</span>
				</button>
			</div>
			<div className="url-bar">
				<SelectMenu
					ariaLabel="HTTP method"
					className="method-select"
					options={METHODS.map((method) => ({ value: method, label: method }))}
					value={request.method}
					onChange={(method) =>
					onChange({
						method,
						...(["GET", "HEAD"].includes(method) && request.body.mode !== "none" ? { body: { mode: "none" } } : {}),
					})
				}
				/>
				<input
					aria-label="Request URL"
					className="url-input"
					placeholder="https://api.example.com/resource or http://127.0.0.1:8000/demo/v1/echo"
					spellCheck="false"
					type="text"
					value={request.urlTemplate}
					onChange={(event) => onChange({ urlTemplate: event.target.value })}
				/>
				<button className="button code-button" title="Generate code for this request" type="button" onClick={onExport}>
					<MaterialIcon size={18}>code</MaterialIcon>
					<span className="button-label">Code</span>
				</button>
				<button className={`send-button ${running ? "cancel" : ""}`} type="button" onClick={onSend}>
					<MaterialIcon size={18}>{running ? "stop" : "send"}</MaterialIcon>
					{running ? "Cancel" : "Send"}
				</button>
			</div>
			<div className="request-editor-tabs" role="tablist" aria-label="Request sections" ref={tabs.listRef} onKeyDown={tabs.onKeyDown}>
				{sections.map((item) => (
					<button
						aria-controls={`request-editor-${item.id}`}
						aria-selected={section === item.id}
						className="editor-tab"
						id={`request-editor-tab-${item.id}`}
						key={item.id}
						role="tab"
						tabIndex={section === item.id ? 0 : -1}
						type="button"
						onClick={() => setSection(item.id)}
					>
						{item.label}
						{item.badge > 0 && <span className="badge">{item.badge}</span>}
					</button>
				))}
			</div>
			<div
				aria-labelledby={`request-editor-tab-${section}`}
				className="request-editor-body"
				id={`request-editor-${section}`}
				role="tabpanel"
			>
				{section === "params" && (
					<KeyValueEditor label="Query parameters" rows={request.query} onChange={(query) => onChange({ query })} />
				)}
				{section === "headers" && (
					<KeyValueEditor label="Headers" rows={request.headers} onChange={(headers) => onChange({ headers })} />
				)}
				{section === "body" && (
					<BodyEditor body={disabledBody ? { mode: "none" } : request.body} onChange={(body) => onChange({ body })} />
				)}
				{section === "auth" && (
					<AuthEditor
						auth={request.auth}
						authOverride={authOverride}
						collectionAuth={collectionAuth}
						onAuthChange={(auth) => onChange({ auth })}
						onOverrideChange={onOverrideChange}
					/>
				)}
				{section === "preRequest" && (
					<ScriptEditor
						kind="preRequest"
						value={request.scripts?.preRequest ?? ""}
						onChange={(preRequest) => onChange({ scripts: { test: request.scripts?.test ?? "", preRequest } })}
					/>
				)}
				{section === "tests" && (
					<ScriptEditor
						kind="test"
						value={request.scripts?.test ?? ""}
						onChange={(test) => onChange({ scripts: { preRequest: request.scripts?.preRequest ?? "", test } })}
					/>
				)}
				{section === "settings" && (
					<div className="settings-grid">
						<div className="field-row">
							<label htmlFor="request-timeout">Timeout (ms)</label>
							<input
								id="request-timeout"
								max={timeoutBounds.max}
								min={timeoutBounds.min}
								step="100"
								type="number"
								value={request.settings.timeoutMs}
								onChange={(event) =>
									onChange({
										settings: {
											...request.settings,
											timeoutMs: Math.min(
												timeoutBounds.max,
												Math.max(timeoutBounds.min, Number(event.target.value) || timeoutBounds.min),
											),
										},
									})
								}
							/>
						</div>
						<p className="field-hint">
							Bounds: {timeoutBounds.min.toLocaleString()}–{timeoutBounds.max.toLocaleString()} ms. Draft version{" "}
							{draftVersion}.{" "}
							{hasCollection
								? "Saved sends freeze the collection revision."
								: "This request is not attached to a collection yet."}{" "}
							Environment variables resolve at send time from the active environment and collection defaults.
						</p>
						<p className="field-hint">
							{environments.length} environment{environments.length === 1 ? "" : "s"} available in this profile.
						</p>
					</div>
				)}
			</div>
			<div>
				<button className="text-button" type="button" onClick={onCancel}>
					Send a scratch request instead
				</button>
			</div>
		</section>
	);
}
