import { useEffect, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import { requestToolsApi } from "../request-tools/request-tools.api.js";
import { writeClipboard } from "./clipboard.js";
import { SNIPPET_FORMATS } from "./snippets.js";

function emptySnippet(format) {
	return {
		ok: false,
		format,
		label: SNIPPET_FORMATS.find((item) => item.value === format)?.label ?? format,
		code: "",
		errors: [],
		warnings: [],
	};
}

// The backend owns request normalization and snippet generation. The dialog only
// selects a format, displays the returned text, and copies it to the clipboard.
export function CodeSnippetDialog({ collectionAuth = null, onClose, request }) {
	const [format, setFormat] = useState("curl");
	const [copyState, setCopyState] = useState("idle");
	const [snippet, setSnippet] = useState(() => emptySnippet("curl"));
	const [loading, setLoading] = useState(true);
	const [apiError, setApiError] = useState("");
	const requestId = useRef(0);
	const tabs = useRovingTabs();

	useEffect(() => {
		const id = ++requestId.current;
		setLoading(true);
		setApiError("");
		setSnippet(emptySnippet(format));
		requestToolsApi
			.generateSnippet(request, format, collectionAuth)
			.then((result) => {
				if (id === requestId.current) setSnippet(result);
			})
			.catch((error) => {
				if (id === requestId.current) setApiError(error.message || "Tracer could not generate this code snippet.");
			})
			.finally(() => {
				if (id === requestId.current) setLoading(false);
			});
	}, [collectionAuth, format, request]);

	const selectFormat = (next) => {
		setFormat(next);
		setCopyState("idle");
	};

	const copy = async () => {
		if (!snippet.ok || loading) return;
		setCopyState((await writeClipboard(snippet.code)) ? "copied" : "failed");
	};

	return (
		<Modal className="code-dialog-modal" label="Generated code for this request" onClose={onClose}>
			<section className="form-dialog code-dialog">
				<h2>Code</h2>
				<p className="import-hint">
					Generated from this request by Tracer's backend. Variable references such as <code>{"{{token}}"}</code> stay as
					placeholders — resolved credentials and send-only auth overrides are never included.
				</p>
				<div aria-label="Code format" className="code-formats" onKeyDown={tabs.onKeyDown} ref={tabs.listRef} role="tablist">
					{SNIPPET_FORMATS.map((item) => (
						<button
							aria-controls="code-preview"
							aria-selected={format === item.value}
							className="code-format"
							key={item.value}
							role="tab"
							tabIndex={format === item.value ? 0 : -1}
							type="button"
							onClick={() => selectFormat(item.value)}
						>
							{item.label}
						</button>
					))}
				</div>
				<div aria-label={`${snippet.label || format} snippet`} className="code-preview" id="code-preview" role="tabpanel">
					{loading ? (
						<p className="code-empty">Generating code…</p>
					) : snippet.ok ? (
						<pre>
							<code>{snippet.code}</code>
						</pre>
					) : (
						<p className="code-empty">This request cannot be exported yet. Fix the problems below and try again.</p>
					)}
				</div>
				{apiError && (
					<div className="dialog-error" role="alert">
						{apiError}
					</div>
				)}
				{snippet.errors.length > 0 && (
					<ul className="import-issues import-errors" role="alert">
						{snippet.errors.map((issue) => (
							<li key={issue.code}>
								<MaterialIcon size={15}>error</MaterialIcon>
								<span>{issue.message}</span>
							</li>
						))}
					</ul>
				)}
				{snippet.warnings.length > 0 && (
					<ul className="import-issues import-warnings">
						{snippet.warnings.map((issue) => (
							<li key={issue.code}>
								<MaterialIcon size={15}>warning</MaterialIcon>
								<span>{issue.message}</span>
							</li>
						))}
					</ul>
				)}
				<footer>
					<p aria-live="polite" className="code-copy-status">
						{copyState === "copied"
							? "Copied to clipboard."
							: copyState === "failed"
								? "Copy failed. Select the code and copy it manually."
								: ""}
					</p>
					<button type="button" onClick={onClose}>
						Close
					</button>
					<button className="primary-button" data-autofocus disabled={!snippet.ok || loading} type="button" onClick={copy}>
						<MaterialIcon size={18}>content_copy</MaterialIcon>
						{copyState === "copied" ? "Copied" : "Copy"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}
