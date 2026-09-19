import { useMemo, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { formatBytes, formatDuration, OUTCOME_LABELS, statusClass } from "../../shared/utils/format.js";
import { JsonTree } from "./JsonTree.jsx";
import { RawView } from "./RawView.jsx";
import { formatHtml, formatXml } from "./markup-format.js";

const JSON_LIMIT = 256 * 1024;

function BodyPanel({ response }) {
    const [view, setView] = useState("pretty");
    const [search, setSearch] = useState("");
    const body = response?.body;
    const text = body?.encoding === "utf8" ? body.value : "";
    const media = (body?.mediaType || "").toLowerCase();
    const canPretty = body?.encoding === "utf8" && !body.truncated && text.length <= JSON_LIMIT;
    const pretty = useMemo(() => {
        if (!canPretty) return null;
        if (media.includes("json") || /^\s*[[{]/.test(text)) {
            try {
                JSON.parse(text);
                return { kind: "json" };
            } catch {
                return null;
            }
        }
        if (media.includes("xml") && !media.includes("html")) {
            const result = formatXml(text);
            return result.ok ? { kind: "text", value: result.text } : { kind: "reason", reason: result.reason };
        }
        if (media.includes("html")) {
            const result = formatHtml(text);
            return result.ok ? { kind: "text", value: result.text } : { kind: "reason", reason: result.reason };
        }
        return null;
    }, [canPretty, media, text]);
    if (!response) return null;
    if (body?.encoding === "base64") {
        return (
            <div className="raw-view">
                <div className="notice info">This response is binary or not valid UTF-8 ({body.mediaType || "unknown media type"}). It is shown as Base64 and never rendered as live content.</div>
                <RawView search={search} text={body.value} />
            </div>
        );
    }
    if (!text) return <p className="field-hint">This response has an empty body.</p>;
    return (
        <div className="raw-view">
            {body.truncated && <div className="notice warning">The captured body was truncated. Only the first part is displayed.</div>}
            <div className="field-row">
                <div className="view-switch" role="group" aria-label="Body view">
                    <button aria-pressed={view === "pretty"} type="button" onClick={() => setView("pretty")}>Pretty</button>
                    <button aria-pressed={view === "raw"} type="button" onClick={() => setView("raw")}>Raw</button>
                </div>
                <input
                    aria-label="Search response body"
                    className="url-input"
                    placeholder="Search in body"
                    style={{ height: 34 }}
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
            </div>
            {view === "raw" ? (
                <RawView search={search} text={text} />
            ) : pretty?.kind === "json" ? (
                <JsonTree text={text} />
            ) : pretty?.kind === "text" ? (
                <RawView search={search} text={pretty.value} />
            ) : (
                <RawView search={search} text={text} />
            )}
            {view === "pretty" && pretty?.kind === "reason" && <div className="notice info">{pretty.reason} Raw source is shown instead.</div>}
        </div>
    );
}

function HeadersPanel({ headers = [] }) {
    if (headers.length === 0) return <p className="field-hint">This response returned no headers.</p>;
    return (
        <dl className="header-table">
            {headers.map((header, index) => (
                <div className="header-row" key={`${header.name}-${index}`}>
                    <dt>{header.name}</dt>
                    <dd>{header.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function DetailsPanel({ result }) {
    const response = result.response;
    const trace = result.compileTrace ?? [];
    return (
        <div className="details-grid">
            <section className="details-card">
                <h3>Timing and size</h3>
                <dl>
                    <dt>Outcome</dt>
                    <dd>{OUTCOME_LABELS[result.outcome] ?? result.outcome}</dd>
                    <dt>Total</dt>
                    <dd>{formatDuration(response?.timing?.totalMs)}</dd>
                    <dt>First byte</dt>
                    <dd>{response?.timing?.firstByteMs === null || response?.timing?.firstByteMs === undefined ? "not received" : formatDuration(response.timing.firstByteMs)}</dd>
                    <dt>Received body</dt>
                    <dd>{formatBytes(response?.size?.receivedBodyBytes)}</dd>
                    <dt>Decoded body</dt>
                    <dd>{formatBytes(response?.size?.decodedBodyBytes)}</dd>
                    <dt>Timeout</dt>
                    <dd>{formatDuration(response?.timeoutMs)}</dd>
                </dl>
            </section>
            <section className="details-card">
                <h3>Resolution</h3>
                <dl>
                    <dt>Executed URL</dt>
                    <dd>{response?.executedUrl ?? "not dispatched"}</dd>
                    <dt>Effect certainty</dt>
                    <dd>{result.effectCertainty === "may_have_reached_target" ? "may have reached the target" : "not dispatched"}</dd>
                    <dt>Persistence</dt>
                    <dd>{result.persistence?.state ?? "saved"}{result.persistence?.warning ? ` — ${result.persistence.warning}` : ""}</dd>
                </dl>
            </section>
            <section className="details-card">
                <h3>Variable resolution</h3>
                {trace.length === 0 ? (
                    <p className="field-hint">No variables were interpolated for this send.</p>
                ) : (
                    <ul className="trace-list">
                        {trace.map((entry, index) => (
                            <li key={`${entry.field}-${entry.variable}-${index}`}>
                                <code>{entry.variable}</code>
                                <span>from {entry.scope} → {entry.field}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {(result.warnings ?? []).length > 0 && (
                <section className="details-card">
                    <h3>Warnings</h3>
                    {result.warnings.map((warning, index) => (
                        <div className="notice warning" key={`${warning.code}-${index}`}>{warning.message}</div>
                    ))}
                </section>
            )}
        </div>
    );
}

export function ResponseViewer({ onCopyUrl, result }) {
    const [tab, setTab] = useState("body");
    const tabs = useRovingTabs();
    if (!result) return null;
    const response = result.response;
    const status = response?.status ?? null;
    const errorMessage = result.error?.message;
    return (
        <section aria-label="Response" className="response-area">
            <div className="response-toolbar">
                <div className="response-summary">
                    {response ? (
                        <>
                            <span className={`status-pill ${statusClass(status)}`}>{status} {response.statusText}</span>
                            <span className="response-metric"><strong>{formatDuration(response.timing.totalMs)}</strong>total</span>
                            <span className="response-metric"><strong>{formatBytes(response.size.decodedBodyBytes)}</strong>decoded</span>
                            <span className="response-metric"><strong>{formatBytes(response.size.receivedBodyBytes)}</strong>received</span>
                            {response.httpVersion && <span className="response-metric"><strong>HTTP {response.httpVersion}</strong>version</span>}
                        </>
                    ) : (
                        <span className={`status-pill ${result.outcome === "cancelled" ? "unknown" : "danger"}`}>{OUTCOME_LABELS[result.outcome] ?? result.outcome}</span>
                    )}
                    {errorMessage && <span className="field-hint">{errorMessage}</span>}
                </div>
                {status !== null && status >= 300 && status < 400 && (
                    <button className="button" type="button" onClick={() => onCopyUrl(response.headers)}>
                        <MaterialIcon size={18}>content_copy</MaterialIcon>
                        <span className="button-label">Copy resolved URL</span>
                    </button>
                )}
            </div>
            {(result.warnings ?? []).map((warning, index) => (
                <div className="notice info" key={`${warning.code}-${index}`} style={{ margin: "10px 16px 0" }}>{warning.message}</div>
            ))}
            {!response ? (
                <div className="response-placeholder">
                    <MaterialIcon size={28}>error_outline</MaterialIcon>
                    <span>{errorMessage ?? "No HTTP response was produced for this send."}</span>
                    {result.error?.code === "TARGET_BLOCKED" && <span className="field-hint">Tracer blocks addresses that are not publicly routable. Only the seeded local demo target on 127.0.0.1:8000 is exempt.</span>}
                </div>
            ) : (
                <>
                    <div className="response-tabs" role="tablist" aria-label="Response sections" ref={tabs.listRef} onKeyDown={tabs.onKeyDown}>
                        <button aria-controls="response-panel-body" aria-selected={tab === "body"} className="editor-tab" id="response-tab-body" role="tab" tabIndex={tab === "body" ? 0 : -1} type="button" onClick={() => setTab("body")}>Body</button>
                        <button aria-controls="response-panel-headers" aria-selected={tab === "headers"} className="editor-tab" id="response-tab-headers" role="tab" tabIndex={tab === "headers" ? 0 : -1} type="button" onClick={() => setTab("headers")}>Headers<span className="badge">{response.headers.length}</span></button>
                        <button aria-controls="response-panel-details" aria-selected={tab === "details"} className="editor-tab" id="response-tab-details" role="tab" tabIndex={tab === "details" ? 0 : -1} type="button" onClick={() => setTab("details")}>Details</button>
                    </div>
                    <div aria-labelledby={`response-tab-${tab}`} className="response-panel" id={`response-panel-${tab}`} role="tabpanel">
                        {tab === "body" && <BodyPanel response={response} />}
                        {tab === "headers" && <HeadersPanel headers={response.headers} />}
                        {tab === "details" && <DetailsPanel result={result} />}
                    </div>
                </>
            )}
        </section>
    );
}
