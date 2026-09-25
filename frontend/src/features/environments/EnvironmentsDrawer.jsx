import { useEffect, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { environmentApi } from "./environment.api.js";

const blankVariable = () => ({ id: crypto.randomUUID(), key: "", kind: "plain", value: "", enabled: true });

function VariableRows({ aliases, onChange, rows }) {
	const update = (id, patch) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	return (
		<div className="kv-editor">
			{rows.length === 0 && <p className="kv-empty">No variables yet. Add one to make it available as {"{{name}}"}.</p>}
			{rows.map((row) => (
				<div className="variable-row" key={row.id}>
					<label className="kv-check">
						<input
							aria-label={`Include ${row.key || "variable"}`}
							checked={row.enabled}
							type="checkbox"
							onChange={(event) => update(row.id, { enabled: event.target.checked })}
						/>
					</label>
					<input
						aria-label="Variable name"
						placeholder="name"
						type="text"
						value={row.key}
						onChange={(event) => update(row.id, { key: event.target.value })}
					/>
					{row.kind === "plain" ? (
						<input
							aria-label="Variable value"
							placeholder="value"
							type="text"
							value={row.value ?? ""}
							onChange={(event) => update(row.id, { value: event.target.value })}
						/>
					) : (
						<SelectMenu
							ariaLabel="Secret reference"
							options={[
								{ value: "", label: "Choose an alias" },
								...aliases.map((alias) => ({
									value: alias.alias,
									label: alias.alias,
									hint: alias.configured ? "configured" : "not configured",
								})),
							]}
							value={row.alias ?? ""}
							onChange={(value) => update(row.id, { alias: value })}
						/>
					)}
					<SelectMenu
						ariaLabel="Variable kind"
						options={[
							{ value: "plain", label: "Value" },
							{ value: "secretRef", label: "Secret" },
						]}
						value={row.kind}
						onChange={(kind) =>
							update(
								row.id,
								kind === "secretRef" ? { kind, value: undefined, alias: "" } : { kind, alias: undefined, value: "" },
							)
						}
					/>
					<button
						aria-label="Remove variable"
						className="icon-button small"
						type="button"
						onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
					>
						<MaterialIcon size={16}>close</MaterialIcon>
					</button>
				</div>
			))}
			<div>
				<button className="text-button" type="button" onClick={() => onChange([...rows, blankVariable()])}>
					<MaterialIcon size={16}>add</MaterialIcon> Add variable
				</button>
			</div>
		</div>
	);
}

function EnvironmentEditor({ aliases, canWrite = true, environment, onCancel, onSaved, onDeleted }) {
	const [name, setName] = useState(environment.name);
	const [variables, setVariables] = useState(environment.variables ?? []);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const save = async () => {
		setBusy(true);
		setError("");
		try {
			const payload = {
				name: name.trim(),
				variables: variables.map((row) => ({
					id: row.id,
					key: row.key.trim(),
					kind: row.kind,
					enabled: row.enabled,
					...(row.kind === "plain" ? { value: row.value ?? "" } : { alias: row.alias }),
				})),
			};
			const updated = await environmentApi.update(environment._id, environment.revision, payload);
			onSaved(updated);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		setBusy(true);
		setError("");
		try {
			await environmentApi.remove(environment._id, environment.revision);
			onDeleted(environment._id);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="form-dialog">
			<h2>Edit environment</h2>
			<div className="form-dialog-body">
				<div className="field-row">
					<label htmlFor="environment-name">Name</label>
					<input
						id="environment-name"
						maxLength={80}
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<VariableRows aliases={aliases} rows={variables} onChange={setVariables} />
				<p className="field-hint">
					Plain values are stored as written and are visible to anyone who can read this profile. Secret references store only the
					alias; the value is resolved on the server at send time and never returned to the browser.
				</p>
				{error && (
					<p className="dialog-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<footer>
				<button className="text-button danger-button" disabled={busy} type="button" onClick={remove}>
					Delete
				</button>
				<span style={{ flex: 1 }} />
				<button className="text-button" disabled={busy} type="button" onClick={onCancel}>
					Cancel
				</button>
				<button className="primary-button" disabled={busy || !canWrite || !name.trim()} type="button" onClick={save}>
					{busy ? "Saving…" : "Save"}
				</button>
			</footer>
		</div>
	);
}

export function EnvironmentsDrawer({ activeEnvironmentId, canWrite = false, onClose, onDeleted, onOpenVersions, onSaved, onSelect }) {
	const [environments, setEnvironments] = useState([]);
	const [aliases, setAliases] = useState([]);
	const [editing, setEditing] = useState(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);

	const load = async () => {
		setLoading(true);
		try {
			const [list, aliasList] = await Promise.all([environmentApi.list(), environmentApi.secretAliases()]);
			setEnvironments(list);
			setAliases(aliasList);
		} catch (caught) {
			setError(caught.message);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		load();
	}, []);

	const open = async (summary) => {
		try {
			setEditing(await environmentApi.get(summary._id));
		} catch (caught) {
			setError(caught.message);
		}
	};

	const create = async () => {
		try {
			const created = await environmentApi.create({ name: `Environment ${environments.length + 1}`, variables: [] });
			setEnvironments((current) => [...current, created]);
			setEditing(created);
		} catch (caught) {
			setError(caught.message);
		}
	};

	return (
		<Modal className="form-dialog-modal" label="Environments" onClose={onClose}>
			{editing ? (
				<EnvironmentEditor
					aliases={aliases}
					canWrite={canWrite}
					environment={editing}
					onCancel={() => setEditing(null)}
					onDeleted={(id) => {
						setEnvironments((current) => current.filter((item) => item._id !== id));
						setEditing(null);
						onDeleted(id);
					}}
					onSaved={(updated) => {
						setEnvironments((current) =>
							current.map((item) =>
								item._id === updated._id ? { ...item, name: updated.name, revision: updated.revision } : item,
							),
						);
						setEditing(updated);
						onSaved(updated);
					}}
				/>
			) : (
				<section className="form-dialog">
					<h2>Environments</h2>
					<div className="form-dialog-body">
						{!canWrite && (
							<p className="workspace-readonly-banner" role="status">
								Read-only: your role in this workspace cannot create or edit environments. Secret values are never
								shared — only variable definitions and alias names travel with a shared environment.
							</p>
						)}
						{loading && <p className="kv-empty">Loading environments…</p>}
						{!loading && error && (
							<p className="dialog-error" role="alert">
								{error}
							</p>
						)}
						{!loading && environments.length === 0 && <p className="kv-empty">No environments yet.</p>}
						{!loading &&
							environments.map((environment) => (
								<div
									className={`environment-row ${activeEnvironmentId === environment._id ? "active" : ""}`}
									key={environment._id}
								>
									<button className="environment-name" type="button" onClick={() => open(environment)}>
										{environment.name}
									</button>
									<small>rev {environment.revision}</small>
									{onOpenVersions && (
										<button className="text-button" type="button" onClick={() => onOpenVersions(environment)}>
											Versions
										</button>
									)}
									<button
										className="text-button"
										type="button"
										onClick={() => {
											onSelect(activeEnvironmentId === environment._id ? null : environment._id);
										}}
									>
										{activeEnvironmentId === environment._id ? "Active" : "Use"}
									</button>
								</div>
							))}
					</div>
					<footer>
						<button
							className="button"
							disabled={!canWrite}
							title={canWrite ? "Create an environment" : "Your workspace role cannot change environments."}
							type="button"
							onClick={create}
						>
							New environment
						</button>
						<span style={{ flex: 1 }} />
						<button className="primary-button" type="button" onClick={onClose}>
							Done
						</button>
					</footer>
				</section>
			)}
		</Modal>
	);
}
