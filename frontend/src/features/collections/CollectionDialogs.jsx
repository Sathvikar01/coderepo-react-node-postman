import { useEffect, useState } from "react";
import { Modal } from "../../shared/components/Modal.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";

export function SaveRequestDialog({ busy = false, collections, error = "", onCancel, onSave, request }) {
	const [collectionId, setCollectionId] = useState(collections[0]?._id ?? "");
	const [folderId, setFolderId] = useState(request?.folderId ?? "");
	const [name, setName] = useState(request?.name ?? "");
	const collection = collections.find((item) => String(item._id) === String(collectionId));
	const folders = collection?.folders ?? [];
	useEffect(() => {
		if (folderId && !folders.some((folder) => folder.id === folderId)) setFolderId("");
	}, [collectionId, folderId, folders]);
	return (
		<Modal
			className="form-dialog-modal"
			label="Save request"
			onClose={() => {
				if (!busy) onCancel();
			}}
		>
			<section className="form-dialog">
				<h2>Save request</h2>
				<div className="form-dialog-body">
					<div className="field-row">
						<label htmlFor="save-name">Name</label>
						<input id="save-name" maxLength={80} type="text" value={name} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="field-row">
						<label htmlFor="save-collection">Collection</label>
						<SelectMenu
							ariaLabel="Target collection"
							options={collections.map((item) => ({ value: item._id, label: item.name }))}
							value={collectionId}
							onChange={(value) => setCollectionId(value)}
						/>
					</div>
					{folders.length > 0 && (
						<div className="field-row">
							<label htmlFor="save-folder">Folder</label>
							<SelectMenu
								ariaLabel="Target folder"
								options={[
									{ value: "", label: "Collection root" },
									...folders.map((folder) => ({ value: folder.id, label: folder.name })),
								]}
								value={folderId}
								onChange={(value) => setFolderId(value)}
							/>
						</div>
					)}
					<p className="field-hint">
						Saving writes to the current collection revision. If someone else changed the collection, Tracer keeps your draft
						and offers to reload or save as a copy.
					</p>
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
					<button
						className="primary-button"
						disabled={busy || !collectionId || !name.trim()}
						type="button"
						onClick={() => onSave({ collectionId, folderId: folderId || null, name: name.trim() })}
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}

export function NewCollectionDialog({ busy = false, error = "", onCancel, onSubmit }) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	return (
		<Modal
			className="form-dialog-modal"
			label="New collection"
			onClose={() => {
				if (!busy) onCancel();
			}}
		>
			<section className="form-dialog">
				<h2>New collection</h2>
				<div className="form-dialog-body">
					<div className="field-row">
						<label htmlFor="collection-name">Name</label>
						<input
							autoFocus
							id="collection-name"
							maxLength={80}
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="field-row">
						<label htmlFor="collection-description">Description</label>
						<input
							id="collection-description"
							maxLength={1000}
							type="text"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<p className="field-hint">
						Collection authentication can be added here later from a saved request or by inheriting at send time.
					</p>
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
					<button
						className="primary-button"
						disabled={busy || !name.trim()}
						type="button"
						onClick={() => onSubmit({ name: name.trim(), description })}
					>
						{busy ? "Creating…" : "Create"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}

export function RenameDialog({ busy = false, error = "", initialValue = "", label = "Rename", onCancel, onSubmit, title }) {
	const [value, setValue] = useState(initialValue);
	return (
		<Modal
			className="form-dialog-modal"
			label={title}
			onClose={() => {
				if (!busy) onCancel();
			}}
		>
			<section className="form-dialog">
				<h2>{title}</h2>
				<div className="form-dialog-body">
					<div className="field-row">
						<label htmlFor="rename-value">{label}</label>
						<input
							autoFocus
							id="rename-value"
							maxLength={80}
							type="text"
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					</div>
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
					<button
						className="primary-button"
						disabled={busy || !value.trim()}
						type="button"
						onClick={() => onSubmit(value.trim())}
					>
						{busy ? "Saving…" : "Save"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}


const blankCollectionVariable = () => ({ id: crypto.randomUUID(), key: "", kind: "plain", value: "", enabled: true });

function CollectionVariablesEditor({ rows, onChange }) {
	const update = (id, patch) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	return (
		<div className="kv-editor">
			{rows.map((row) => (
				<div className="variable-row" key={row.id}>
					<label className="kv-check compact">
						<input aria-label="Variable enabled" checked={row.enabled} type="checkbox" onChange={(event) => update(row.id, { enabled: event.target.checked })} />
					</label>
					<input aria-label="Variable name" placeholder="name" value={row.key} onChange={(event) => update(row.id, { key: event.target.value })} />
					<SelectMenu
						ariaLabel="Variable kind"
						options={[{ value: "plain", label: "Value" }, { value: "secretRef", label: "Secret reference" }]}
						value={row.kind}
						onChange={(kind) =>
							update(row.id, kind === "plain" ? { kind, value: row.value ?? "", alias: undefined } : { kind, value: undefined, alias: row.alias ?? "" })
						}
					/>
					<input
						aria-label={row.kind === "plain" ? "Variable value" : "Secret alias"}
						placeholder={row.kind === "plain" ? "value" : "alias"}
						value={row.kind === "plain" ? (row.value ?? "") : (row.alias ?? "")}
						onChange={(event) =>
							update(row.id, row.kind === "plain" ? { value: event.target.value } : { alias: event.target.value })
						}
					/>
					<button className="icon-button small" aria-label="Remove variable" type="button" onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
						×
					</button>
				</div>
			))}
			<button className="text-button" type="button" onClick={() => onChange([...rows, blankCollectionVariable()])}>
				Add variable
			</button>
		</div>
	);
}

function CollectionAuthEditor({ auth, onChange }) {
	const setMode = (mode) =>
		onChange(
			mode === "bearer"
				? { mode, tokenTemplate: "" }
				: mode === "basic"
					? { mode, usernameTemplate: "", passwordTemplate: "" }
					: mode === "apiKey"
						? { mode, key: "", valueTemplate: "", in: "header" }
						: { mode: "none" },
		);
	return (
		<div className="settings-grid">
			<div className="field-row">
				<label>Collection authentication</label>
				<SelectMenu
					ariaLabel="Collection authentication"
					options={[
						{ value: "none", label: "No auth" },
						{ value: "bearer", label: "Bearer token" },
						{ value: "basic", label: "Basic auth" },
						{ value: "apiKey", label: "API key" },
					]}
					value={auth.mode}
					onChange={setMode}
				/>
			</div>
			{auth.mode === "bearer" && (
				<input placeholder="{{token}}" value={auth.tokenTemplate ?? ""} onChange={(event) => onChange({ ...auth, tokenTemplate: event.target.value })} />
			)}
			{auth.mode === "basic" && (
				<>
					<input placeholder="{{username}}" value={auth.usernameTemplate ?? ""} onChange={(event) => onChange({ ...auth, usernameTemplate: event.target.value })} />
					<input placeholder="{{password}}" value={auth.passwordTemplate ?? ""} onChange={(event) => onChange({ ...auth, passwordTemplate: event.target.value })} />
				</>
			)}
			{auth.mode === "apiKey" && (
				<>
					<input placeholder="X-API-Key" value={auth.key ?? ""} onChange={(event) => onChange({ ...auth, key: event.target.value })} />
					<input placeholder="{{api_key}}" value={auth.valueTemplate ?? ""} onChange={(event) => onChange({ ...auth, valueTemplate: event.target.value })} />
					<SelectMenu
						ariaLabel="API key placement"
						options={[{ value: "header", label: "Header" }, { value: "query", label: "Query" }]}
						value={auth.in ?? "header"}
						onChange={(value) => onChange({ ...auth, in: value })}
					/>
				</>
			)}
			<p className="field-hint">Credential values must use variable references. Collection auth cannot inherit.</p>
		</div>
	);
}

export function CollectionSettingsDialog({ busy = false, collection, error = "", onCancel, onSave }) {
	const [variables, setVariables] = useState(() => structuredClone(collection.variables ?? []));
	const [auth, setAuth] = useState(() => structuredClone(collection.auth ?? { mode: "none" }));
	return (
		<Modal className="form-dialog-modal" label="Collection defaults" onClose={() => !busy && onCancel()}>
			<section className="form-dialog">
				<h2>{collection.name} defaults</h2>
				<div className="form-dialog-body">
					<h3>Variables</h3>
					<CollectionVariablesEditor rows={variables} onChange={setVariables} />
					<h3>Authentication</h3>
					<CollectionAuthEditor auth={auth} onChange={setAuth} />
					{error && <p className="dialog-error" role="alert">{error}</p>}
				</div>
				<footer>
					<button className="text-button" disabled={busy} type="button" onClick={onCancel}>Cancel</button>
					<button
						className="primary-button"
						disabled={busy}
						type="button"
						onClick={() =>
							onSave({
								variables: variables.map((row) => ({
									id: row.id,
									key: row.key.trim(),
									kind: row.kind,
									enabled: row.enabled,
									...(row.kind === "plain" ? { value: row.value ?? "" } : { alias: row.alias?.trim() ?? "" }),
								})),
								auth,
							})
						}
					>
						{busy ? "Saving…" : "Save defaults"}
					</button>
				</footer>
			</section>
		</Modal>
	);
}
