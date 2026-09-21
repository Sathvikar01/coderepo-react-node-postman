import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { buildCollectionDocs } from "./docs-model.js";
import { collectionDocsFileName, collectionDocsToMarkdown, requestDocsToMarkdown } from "./docs-markdown.js";
import "./docs.css";

function CopyButton({ label, text }) {
	const [state, setState] = useState("idle");
	const timer = useRef(null);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = async () => {
		try {
			if (!navigator.clipboard) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(text);
			setState("copied");
		} catch {
			setState("failed");
		}
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1600);
	};
	const caption = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
	return (
		<button aria-label={state === "idle" ? `${label} to clipboard` : caption} className="docs-copy" onClick={copy} type="button">
			<MaterialIcon size={14}>{state === "copied" ? "check" : state === "failed" ? "warning" : "content_copy"}</MaterialIcon>
			<span>{caption}</span>
		</button>
	);
}

function DocsTable({ headers, rows, caption }) {
	return (
		<table className="docs-table">
			{caption && <caption>{caption}</caption>}
			<thead>
				<tr>
					{headers.map((header) => (
						<th key={header} scope="col">
							{header}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr key={row.key}>
						{row.cells.map((cell, index) =>
							index === 0 ? (
								<th key={`${row.key}-0`} scope="row">
									{cell}
								</th>
							) : (
								<td key={`${row.key}-${index}`}>{cell}</td>
							),
						)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function DocsSection({ action, children, id, title }) {
	return (
		<section className="docs-section" id={id}>
			<header className="docs-section-head">
				<h4>{title}</h4>
				{action}
			</header>
			{children}
		</section>
	);
}

function RowTable({ enabledLabel, rows }) {
	return (
		<DocsTable
			headers={["Name", "Value", enabledLabel]}
			rows={rows.map((row, index) => ({
				key: `${row.id}-${index}`,
				cells: [
					row.key || <em className="docs-quiet">(empty)</em>,
					row.value ? row.value : <em className="docs-quiet">(empty)</em>,
					row.enabled ? "Enabled" : "Disabled",
				],
			}))}
		/>
	);
}

function ExampleBlock({ example, index }) {
	return (
		<div className="docs-example">
			<div className="docs-example-head">
				<strong>{example.name}</strong>
				{example.status !== null && <span className="docs-badge">status {example.status}</span>}
				{example.body && <CopyButton label="Copy example body" text={example.body} />}
			</div>
			{example.headers.length > 0 && (
				<DocsTable
					headers={["Header", "Value"]}
					rows={example.headers.map((header, position) => ({ key: `${index}-h${position}`, cells: [header.name, header.value] }))}
				/>
			)}
			{example.body ? (
				<>
					<pre className="docs-code">{example.body}</pre>
					{example.bodyTruncated && <p className="docs-quiet">This example body was shortened for documentation.</p>}
				</>
			) : (
				<p className="docs-quiet">No body recorded for this example.</p>
			)}
		</div>
	);
}

function RequestDocs({ request }) {
	const markdown = useMemo(() => requestDocsToMarkdown(request), [request]);
	return (
		<section className="docs-request" id={request.anchor}>
			<header className="docs-request-head">
				<span className={`method-tag ${request.method.toLowerCase()}`}>{request.method}</span>
				<h3>{request.name}</h3>
				<CopyButton label="Copy request" text={markdown} />
			</header>
			<div className="docs-url">
				<code>{request.url}</code>
				<CopyButton label="Copy URL" text={request.url} />
			</div>
			{request.description && <p className="docs-description">{request.description}</p>}
			<DocsSection title="Auth">
				<p>
					{request.auth.label}
					{request.auth.inherited && <em className="docs-quiet"> — inherited from the collection</em>}
				</p>
				{request.auth.fields.length > 0 && (
					<DocsTable
						headers={["Field", "Value"]}
						rows={request.auth.fields.map((field, index) => ({
							key: `auth-${index}`,
							cells: [field.label, field.text || "(empty)"],
						}))}
					/>
				)}
				{request.auth.fields.some((field) => field.masked) && (
					<p className="docs-quiet">Literal credential text is masked; only variable references appear here.</p>
				)}
			</DocsSection>
			{request.query.length > 0 && (
				<DocsSection title="Query parameters">
					<RowTable enabledLabel="State" rows={request.query} />
					{request.query.some((row) => row.truncated) && <p className="docs-quiet">Some values were shortened for this view.</p>}
				</DocsSection>
			)}
			{request.headers.length > 0 && (
				<DocsSection title="Headers">
					<RowTable enabledLabel="State" rows={request.headers} />
				</DocsSection>
			)}
			<DocsSection action={request.body.text ? <CopyButton label="Copy body" text={request.body.text} /> : null} title="Body">
				<>
					{request.body.mode === "none" && <p className="docs-quiet">This request has no body.</p>}
					{request.body.mode === "urlencoded" && <RowTable enabledLabel="State" rows={request.body.rows} />}
					{request.body.text && (
						<>
							<p className="docs-quiet">
								{request.body.mode === "json" ? "application/json" : request.body.contentType || "text/plain"}
							</p>
							<pre className="docs-code">{request.body.text}</pre>
						</>
					)}
					{request.body.notices.map((notice) => (
						<p className="docs-notice" key={notice}>
							{notice}
						</p>
					))}
				</>
			</DocsSection>
			{request.variables.length > 0 && (
				<DocsSection title="Variables">
					<ul className="docs-list">
						{request.variables.map((entry) => (
							<li key={entry.name}>
								<code>{`{{${entry.name}}}`}</code> <span className="docs-quiet">{entry.label}</span>
							</li>
						))}
					</ul>
				</DocsSection>
			)}
			{request.examples.length > 0 && (
				<DocsSection title="Response examples">
					{request.examples.map((example, index) => (
						<ExampleBlock example={example} index={index} key={example.id} />
					))}
				</DocsSection>
			)}
		</section>
	);
}

export function DocsView({ collection, onClose }) {
	const model = useMemo(() => buildCollectionDocs(collection), [collection]);
	const markdown = useMemo(() => collectionDocsToMarkdown(model), [model]);
	const [note, setNote] = useState("");

	const scrollTo = (event, anchor) => {
		event.preventDefault();
		document.getElementById(anchor)?.scrollIntoView({ block: "start" });
	};

	const download = () => {
		if (typeof URL?.createObjectURL !== "function") {
			setNote("This browser cannot download files.");
			return;
		}
		const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.download = collectionDocsFileName(model.name);
		anchor.href = url;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
		setNote("Markdown file downloaded.");
	};

	return (
		<Modal className="docs-modal" labelledBy="docs-title" onClose={onClose}>
			<header className="docs-header">
				<div className="docs-identity">
					<MaterialIcon size={20}>description</MaterialIcon>
					<h2 id="docs-title">{model.name}</h2>
					{model.revision !== null && <span className="docs-badge">revision {model.revision}</span>}
				</div>
				<div className="docs-toolbar">
					<CopyButton label="Copy Markdown" text={markdown} />
					<button className="docs-action" onClick={download} type="button">
						<MaterialIcon size={14}>download</MaterialIcon>
						<span>Download .md</span>
					</button>
					<button aria-label="Close documentation" className="icon-button" onClick={onClose} type="button">
						<MaterialIcon size={20}>close</MaterialIcon>
					</button>
				</div>
			</header>
			<p className="docs-generated-note">
				Generated from the saved collection{model.updatedAt ? ` last updated ${new Date(model.updatedAt).toLocaleString()}` : ""}.
				Unsaved edits and send-only auth are never included, and variable values are never shown.
			</p>
			{note && (
				<p className="docs-notice" role="status">
					{note}
				</p>
			)}
			<div className="docs-body">
				<nav aria-label="Documentation navigation" className="docs-nav">
					<a href="#docs-overview" onClick={(event) => scrollTo(event, "docs-overview")}>
						Overview
					</a>
					{model.variables.length > 0 && (
						<a href="#docs-variables" onClick={(event) => scrollTo(event, "docs-variables")}>
							Variables
						</a>
					)}
					{model.requests.map((request, index) => (
						<Fragment key={`${request.id}-${index}`}>
							{(index === 0 || model.requests[index - 1].group.id !== request.group.id) && (
								<span className="docs-nav-group">{request.group.name}</span>
							)}
							<a href={`#${request.anchor}`} onClick={(event) => scrollTo(event, request.anchor)}>
								<span className={`method-tag ${request.method.toLowerCase()}`}>{request.method}</span>
								<span className="docs-nav-name">{request.name}</span>
							</a>
						</Fragment>
					))}
				</nav>
				<article className="docs-content">
					<section id="docs-overview">
						{model.description && <p className="docs-description">{model.description}</p>}
						<p className="docs-quiet">
							{model.requestCount} request{model.requestCount === 1 ? "" : "s"} in this collection.
						</p>
					</section>
					{model.variables.length > 0 && (
						<DocsSection id="docs-variables" title="Variables">
							<DocsTable
								headers={["Name", "Source", "Used by"]}
								rows={model.variables.map((entry) => ({
									key: entry.key,
									cells: [
										`{{${entry.key}}}`,
										entry.label,
										entry.usedByCount === 0
											? "not referenced"
											: `${entry.usedByCount} request${entry.usedByCount === 1 ? "" : "s"}`,
									],
								}))}
							/>
							<p className="docs-quiet">Values are resolved at send time and are never part of generated documentation.</p>
						</DocsSection>
					)}
					{model.overflow > 0 && <p className="docs-notice">{model.overflow} further request(s) are not shown in this view.</p>}
					{model.requests.length === 0 ? (
						<div className="docs-empty">
							<MaterialIcon size={26}>description</MaterialIcon>
							<p>This collection has no saved requests yet. Save a request to generate its documentation.</p>
						</div>
					) : (
						model.requests.map((request, index) => (
							<Fragment key={`${request.id}-${index}`}>
								{(index === 0 || model.requests[index - 1].group.id !== request.group.id) && (
									<h3 className="docs-group">{request.group.name}</h3>
								)}
								<RequestDocs request={request} />
							</Fragment>
						))
					)}
				</article>
			</div>
		</Modal>
	);
}
