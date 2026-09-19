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
