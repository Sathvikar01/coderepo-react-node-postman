import { useMemo, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { parseCurl } from "./curl-parser.js";

const PLACEHOLDER = `curl -X POST http://127.0.0.1:8000/demo/v1/echo \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"Ada"}'`;

const byteLength = (text) => new TextEncoder().encode(text).length;

function bodySummary(body) {
	if (body.mode === "json") return `JSON · ${byteLength(body.text)} bytes`;
	if (body.mode === "text") return `${body.contentType} · ${byteLength(body.text)} bytes`;
	if (body.mode === "urlencoded") return `Form URL encoded · ${body.rows?.length ?? 0} row(s)`;
	return "None";
}

export function ImportCurlDialog({ onCancel, onImport }) {
	const [text, setText] = useState("");
	const parsed = useMemo(() => (text.trim() ? parseCurl(text) : null), [text]);
	const importable = Boolean(parsed?.ok);
	const errors = parsed?.errors ?? [];
	const warnings = parsed?.warnings ?? [];
	const request = parsed?.request ?? null;
	const status = !parsed
		? ""
		: parsed.ok
			? `Parsed ${request.method} ${request.urlTemplate}. ${warnings.length} warning(s), no errors.`
			: `${errors.length} error(s) prevent import.`;

	return (
		<Modal className="import-dialog-modal" label="Import a cURL command" onClose={onCancel}>
			<section className="form-dialog import-dialog">
				<h2>Import cURL</h2>
				<p className="import-hint">
					Paste a cURL command. Tracer parses it and opens the result as an unsaved draft — nothing is saved or sent by importing.
				</p>
				<div className="form-dialog-body">
					<label className="import-field">
						<span>cURL command</span>
						<textarea
							autoFocus
							placeholder={PLACEHOLDER}
							rows={6}
							spellCheck={false}
							value={text}
							onChange={(event) => setText(event.target.value)}
							onKeyDown={(event) => {
								if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && importable) {
									event.preventDefault();
									onImport(parsed);
								}
							}}
						/>
					</label>
					<p aria-live="polite" className="sr-only">
						{status}
					</p>
					<div aria-label="Parsed request preview" className="import-preview" role="region">
						{!parsed && <p className="import-empty">The parsed request appears here before you import it.</p>}
						{request && (
							<>
								<div className="import-summary">
									<span className={`method-tag ${request.method.toLowerCase()}`}>{request.method}</span>
									<code className="import-url">{request.urlTemplate}</code>
								</div>
								<dl className="import-facts">
									<div>
										<dt>Headers</dt>
										<dd>{request.headers.length}</dd>
									</div>
									<div>
										<dt>Body</dt>
										<dd>{bodySummary(request.body)}</dd>
									</div>
									<div>
										<dt>Auth</dt>
										<dd>{parsed.authOverride ? "Basic (send-only credentials)" : "None"}</dd>
									</div>
									<div>
										<dt>Timeout</dt>
										<dd>{request.settings.timeoutMs} ms</dd>
									</div>
								</dl>
								{request.headers.length > 0 && (
									<ul className="import-headers">
										{request.headers.map((header, index) => (
											<li key={`${header.key}-${index}`}>
												<span>{header.key}</span>
												<code>{header.value || "(empty)"}</code>
											</li>
										))}
									</ul>
								)}
								{request.body.mode !== "none" && <pre className="import-body">{request.body.text}</pre>}
							</>
						)}
					</div>
					{errors.length > 0 && (
						<ul className="import-issues import-errors" role="alert">
							{errors.map((issue, index) => (
								<li key={`${issue.code}-${index}`}>
									<MaterialIcon size={15}>error</MaterialIcon>
									<span>{issue.message}</span>
								</li>
							))}
						</ul>
					)}
					{warnings.length > 0 && (
						<ul className="import-issues import-warnings">
							{warnings.map((issue, index) => (
								<li key={`${issue.code}-${index}`}>
									<MaterialIcon size={15}>warning</MaterialIcon>
									<span>{issue.message}</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<footer>
					<button type="button" onClick={onCancel}>
						Cancel
					</button>
					<button
						className="primary-button"
						disabled={!importable}
						title={importable ? "Open the parsed request as an unsaved draft" : "Fix the errors above to import"}
						type="button"
						onClick={() => onImport(parsed)}
					>
						<MaterialIcon size={18}>download</MaterialIcon>
						Import as draft
					</button>
				</footer>
			</section>
		</Modal>
	);
}
