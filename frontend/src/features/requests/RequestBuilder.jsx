import { useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
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

function AuthEditor({ auth, authOverride, collectionAuth, onChange, onOverrideChange }) {
    const mode = authOverride ? authOverride.mode : auth?.mode ?? "inherit";
    const effective = authOverride ?? auth ?? { mode: "none" };
    const setMode = (nextMode) => {
        if (nextMode === "inherit") return onOverrideChange(null);
        const base = nextMode === "bearer" ? { mode: "bearer", tokenTemplate: "" }
            : nextMode === "basic" ? { mode: "basic", usernameTemplate: "", passwordTemplate: "" }
            : nextMode === "apiKey" ? { mode: "apiKey", key: "", valueTemplate: "", in: "header" }
            : { mode: "none" };
        return onOverrideChange(base);
    };
    const update = (patch) => onOverrideChange({ ...effective, ...patch });
    const inheritSource = auth?.mode === "inherit" ? collectionAuth : null;
    return (
        <div className="settings-grid">
            <div className="field-row">
                <label htmlFor="auth-mode">Authentication</label>
                <SelectMenu ariaLabel="Authentication mode" options={AUTH_MODES} value={mode} onChange={setMode} />
            </div>
            {mode === "inherit" && (
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
                        <SelectMenu
                            ariaLabel="Where to add the API key"
                            options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]}
                            value={effective.in ?? "header"}
                            onChange={(value) => update({ in: value })}
                        />
                    </div>
                </>
            )}
            {authOverride && <p className="field-hint">This override applies to the next send only and is not saved with the request.</p>}
        </div>
    );
}

function BodyEditor({ body, onChange }) {
    const update = (patch) => onChange({ ...body, ...patch });
    return (
        <div className="raw-editor">
            <div className="field-row">
                <label htmlFor="body-mode">Body type</label>
                <SelectMenu ariaLabel="Body type" options={BODY_MODES} value={body.mode} onChange={(mode) => update({ mode, ...(mode === "json" && !body.text ? { text: "{\n  \n}" } : {}) })} />
            </div>
            {body.mode === "none" && <p className="field-hint">This request is sent without a body. GET and HEAD requests never include one.</p>}
            {(body.mode === "json" || body.mode === "text") && (
                <>
                    <textarea
                        aria-label={body.mode === "json" ? "JSON body" : "Text body"}
                        spellCheck="false"
                        value={body.text ?? ""}
                        onChange={(event) => update({ text: event.target.value })}
                    />
                    {body.mode === "json" && <p className="field-hint">Variables are interpolated literally. Numeric values can replace an unquoted placeholder; strings containing quotes or line breaks must be escaped by you. The JSON is validated after interpolation.</p>}
                    {body.mode === "text" && (
                        <div className="field-row">
                            <label htmlFor="body-content-type">Content type</label>
                            <input id="body-content-type" type="text" value={body.contentType ?? "text/plain"} onChange={(event) => update({ contentType: event.target.value })} />
                        </div>
                    )}
                </>
            )}
            {body.mode === "urlencoded" && <KeyValueEditor label="Form fields" rows={body.rows ?? []} onChange={(rows) => update({ rows })} keyPlaceholder="Field" />}
        </div>
    );
}

export function RequestBuilder({ authOverride, collectionAuth, draftVersion, environments, executionPolicy, hasCollection, onCancel, onChange, onOverrideChange, onSave, onSend, request, running, savedName }) {
    const [section, setSection] = useState("params");
    const disabledBody = ["GET", "HEAD"].includes(request.method);
    const timeoutBounds = { min: executionPolicy?.minTimeoutMs ?? 100, max: executionPolicy?.maxTimeoutMs ?? 30000 };
    const sections = [
        { id: "params", label: "Params", badge: countEnabled(request.query) },
        { id: "headers", label: "Headers", badge: countEnabled(request.headers) },
        { id: "body", label: "Body", badge: request.body.mode === "none" ? 0 : 1 },
        { id: "auth", label: "Auth", badge: request.auth.mode === "inherit" ? 0 : 1 },
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
                <SelectMenu ariaLabel="HTTP method" className="method-select" options={METHODS.map((method) => ({ value: method, label: method }))} value={request.method} onChange={(method) => onChange({ method, ...(disabledBody ? {} : {}) })} />
                <input
                    aria-label="Request URL"
                    className="url-input"
                    placeholder="https://api.example.com/resource or http://127.0.0.1:8000/demo/v1/echo"
                    spellCheck="false"
                    type="text"
                    value={request.urlTemplate}
                    onChange={(event) => onChange({ urlTemplate: event.target.value })}
                />
                <button className={`send-button ${running ? "cancel" : ""}`} type="button" onClick={onSend}>
                    <MaterialIcon size={18}>{running ? "stop" : "send"}</MaterialIcon>
                    {running ? "Cancel" : "Send"}
                </button>
            </div>
            <div className="request-editor-tabs" role="tablist" aria-label="Request sections">
                {sections.map((item) => (
                    <button
                        aria-selected={section === item.id}
                        className="editor-tab"
                        key={item.id}
                        role="tab"
                        type="button"
                        onClick={() => setSection(item.id)}
                    >
                        {item.label}
                        {item.badge > 0 && <span className="badge">{item.badge}</span>}
                    </button>
                ))}
            </div>
            <div className="request-editor-body" role="tabpanel" aria-label={`${section} editor`}>
                {section === "params" && <KeyValueEditor label="Query parameters" rows={request.query} onChange={(query) => onChange({ query })} />}
                {section === "headers" && <KeyValueEditor label="Headers" rows={request.headers} onChange={(headers) => onChange({ headers })} />}
                {section === "body" && <BodyEditor body={disabledBody ? { mode: "none" } : request.body} onChange={(body) => onChange({ body })} />}
                {section === "auth" && <AuthEditor auth={request.auth} authOverride={authOverride} collectionAuth={collectionAuth} onChange={() => {}} onOverrideChange={onOverrideChange} />}
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
                                onChange={(event) => onChange({ settings: { ...request.settings, timeoutMs: Math.min(timeoutBounds.max, Math.max(timeoutBounds.min, Number(event.target.value) || timeoutBounds.min)) } })}
                            />
                        </div>
                        <p className="field-hint">
                            Bounds: {timeoutBounds.min.toLocaleString()}–{timeoutBounds.max.toLocaleString()} ms. Draft version {draftVersion}. {hasCollection ? "Saved sends freeze the collection revision." : "This request is not attached to a collection yet."} Environment variables resolve at send time from the active environment and collection defaults.
                        </p>
                        <p className="field-hint">{environments.length} environment{environments.length === 1 ? "" : "s"} available in this profile.</p>
                    </div>
                )}
            </div>
            <div>
                <button className="text-button" type="button" onClick={onCancel}>Send a scratch request instead</button>
            </div>
        </section>
    );
}
