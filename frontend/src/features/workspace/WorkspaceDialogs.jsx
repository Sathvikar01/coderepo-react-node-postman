import { ConfirmationDialog } from "../../shared/components/ConfirmationDialog.jsx";
import { CollectionSettingsDialog, NewCollectionDialog, RenameDialog, SaveRequestDialog } from "../collections/CollectionDialogs.jsx";
import { CodeSnippetDialog } from "../export/CodeSnippetDialog.jsx";
import { ImportCurlDialog } from "../import/ImportCurlDialog.jsx";

// Renders whichever workspace dialog is currently open. All state and side effects stay
// with the caller; this component only maps dialog.kind to the right surface.
export function WorkspaceDialogs({ actions, collectionAuth = null, collections, dialog, dialogError, busy, activeTab, onClose }) {
	if (!dialog) return null;

	if (dialog.kind === "code-snippet") {
		return <CodeSnippetDialog collectionAuth={collectionAuth} request={activeTab?.request ?? null} onClose={onClose} />;
	}

	if (dialog.kind === "import-curl") {
		return <ImportCurlDialog onCancel={onClose} onImport={actions.importCurl} />;
	}

	if (dialog.kind === "save-request") {
		const draftRequest = dialog.request ?? activeTab?.request;
		return (
			<SaveRequestDialog
				busy={busy}
				collections={collections}
				error={dialogError}
				onCancel={onClose}
				onSave={(payload) =>
					actions.saveAsNewRequest(
						payload,
						draftRequest,
						Object.prototype.hasOwnProperty.call(dialog, "tabId") ? dialog.tabId : (activeTab?.id ?? null),
					)
				}
				request={draftRequest}
			/>
		);
	}

	if (dialog.kind === "collection-settings") {
		return (
			<CollectionSettingsDialog
				busy={busy}
				collection={dialog.collection}
				error={dialogError}
				onCancel={onClose}
				onSave={(payload) => actions.saveCollectionDefaults(dialog.collection, payload)}
			/>
		);
	}

	if (dialog.kind === "delete-collection") {
		return (
			<ConfirmationDialog
				busy={busy}
				confirmLabel="Delete collection"
				message={`Delete "${dialog.collection.name}" and its ${dialog.collection.requests?.length ?? 0} saved request(s)? History entries are kept because they store their own snapshots.`}
				onCancel={onClose}
				onConfirm={() => actions.deleteCollection(dialog.collection)}
				title="Delete collection"
			/>
		);
	}

	if (dialog.kind === "duplicate-collection") {
		return (
			<RenameDialog
				busy={busy}
				error={dialogError}
				initialValue={`${dialog.collection.name} copy`}
				label="New collection name"
				title="Duplicate collection"
				onCancel={onClose}
				onSubmit={(name) => actions.duplicateCollection(dialog.collection, name)}
			/>
		);
	}

	if (dialog.kind === "new-collection") {
		return (
			<NewCollectionDialog
				busy={busy}
				error={dialogError}
				onCancel={onClose}
				onSubmit={(payload) => actions.createCollection(payload)}
			/>
		);
	}

	if (dialog.kind === "rename-collection") {
		return (
			<RenameDialog
				busy={busy}
				error={dialogError}
				initialValue={dialog.collection.name}
				label="Collection name"
				title="Rename collection"
				onCancel={onClose}
				onSubmit={(name) => actions.renameCollection(dialog.collection, name)}
			/>
		);
	}

	if (dialog.kind === "new-folder") {
		return (
			<RenameDialog
				busy={busy}
				error={dialogError}
				initialValue=""
				label="Folder name"
				title="New folder"
				onCancel={onClose}
				onSubmit={(name) => actions.createFolder(dialog.collection, name)}
			/>
		);
	}

	if (dialog.kind === "rename-folder") {
		return (
			<RenameDialog
				busy={busy}
				error={dialogError}
				initialValue={dialog.folder.name}
				label="Folder name"
				title="Rename folder"
				onCancel={onClose}
				onSubmit={(name) => actions.renameFolder(dialog.collection, dialog.folder, name)}
			/>
		);
	}

	if (dialog.kind === "conflict") {
		const collection = collections.find((item) => item._id === dialog.collectionId) ?? dialog.collection;
		return (
			<ConfirmationDialog
				busy={busy}
				confirmLabel="Save as a copy"
				message="This collection changed since it was loaded. Reload the latest revision to continue editing, or save your draft as a new request."
				onCancel={onClose}
				onConfirm={() => actions.saveAsCopy(dialog.tabId)}
				title="Collection changed"
				error={dialogError}
				extraFooter={
					<button className="text-button" type="button" onClick={() => actions.reloadCollection(collection._id, dialog.tabId)}>
						Reload
					</button>
				}
			/>
		);
	}


	if (dialog.kind === "delete-folder") {
		return (
			<ConfirmationDialog
				busy={busy}
				confirmLabel="Delete folder"
				message={dialog.message}
				onCancel={onClose}
				onConfirm={() => actions.deleteFolder(dialog.collection, dialog.folder.id)}
				title="Delete folder"
			/>
		);
	}

	if (dialog.kind === "close-tab") {
		return (
			<ConfirmationDialog
				busy={false}
				confirmLabel="Discard and close"
				message={dialog.message}
				onCancel={onClose}
				onConfirm={() => actions.discardTab(dialog.tabId)}
				title={dialog.title}
			/>
		);
	}

	if (dialog.kind === "switch-profile") {
		return (
			<ConfirmationDialog
				busy={false}
				confirmLabel="Switch profile"
				message="Switching profiles closes every open request tab and cancels active sends. Unsaved changes are discarded."
				onCancel={onClose}
				onConfirm={() => actions.confirmProfileSwitch()}
				title="Switch profile"
			/>
		);
	}

	if (dialog.kind === "switch-workspace") {
		return (
			<ConfirmationDialog
				busy={false}
				confirmLabel="Switch workspace"
				message="Switching workspaces closes every open request tab and cancels active sends. Unsaved changes are discarded. Each workspace keeps its own collections and environments."
				onCancel={onClose}
				onConfirm={() => actions.confirmWorkspaceSwitch()}
				title="Switch workspace"
			/>
		);
	}

	if (dialog.kind === "clear-history") {
		return (
			<ConfirmationDialog
				busy={busy}
				confirmLabel="Clear history"
				message="Visible history entries are hidden and their stored bodies removed. Execution receipts stay until they expire so duplicates are never re-sent."
				onCancel={onClose}
				onConfirm={() => actions.clearHistory()}
				title="Clear history"
			/>
		);
	}

	return null;
}
