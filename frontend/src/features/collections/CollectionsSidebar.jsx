import { useMemo, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Menu } from "../../shared/components/Menu.jsx";

function methodClass(method) {
	return `method-tag ${(method || "").toLowerCase()}`;
}

function RequestRow({ active, onDelete, onDuplicate, onMove, onOpen, request }) {
	return (
		<div className={`tree-row ${active ? "active" : ""}`}>
			<span style={{ width: 26 }} />
			<button className="tree-label" type="button" onClick={() => onOpen(request)}>
				<span className={methodClass(request.method)}>{request.method}</span>
				<span>{request.name}</span>
			</button>
			<span className="tree-actions">
				<Menu
					items={[
						{ icon: "arrow_drop_up", label: "Move up", onSelect: () => onMove(request.id, -1) },
						{ icon: "arrow_drop_down", label: "Move down", onSelect: () => onMove(request.id, 1) },
						{ separator: true },
						{ icon: "content_copy", label: "Duplicate", onSelect: () => onDuplicate(request.id) },
						{ separator: true },
						{ danger: true, icon: "delete", label: "Delete request", onSelect: () => onDelete(request.id) },
					]}
					label={`Actions for ${request.name}`}
				/>
			</span>
		</div>
	);
}

export function CollectionsSidebar({
	activeCollectionId,
	activeRequestId,
	collections,
	collectionOrder,
	loading,
	onDeleteCollection,
	onDeleteFolder,
	onDeleteRequest,
	onDuplicateCollection,
	onDuplicateFolder,
	onDuplicateRequest,
	onMoveRequest,
	onNewCollection,
	onNewFolder,
	onOpenCollection,
	onOpenRequest,
	onRenameCollection,
	onRenameFolder,
	onReorderCollection,
}) {
	const [expanded, setExpanded] = useState({});
	const ordered = useMemo(() => {
		const byId = new Map(collections.map((collection) => [String(collection._id), collection]));
		const result = [];
		for (const id of collectionOrder) {
			const collection = byId.get(String(id));
			if (collection) {
				result.push(collection);
				byId.delete(String(id));
			}
		}
		for (const collection of byId.values()) result.push(collection);
		return result;
	}, [collectionOrder, collections]);

	const toggle = (id) => setExpanded((current) => ({ ...current, [id]: !current[id] }));

	return (
		<div className="sidebar-panel">
			<div className="sidebar-section-label">
				<span>Collections</span>
				<button aria-label="New collection" className="icon-button small" type="button" onClick={onNewCollection}>
					<MaterialIcon size={18}>add</MaterialIcon>
				</button>
			</div>
			{loading && <p className="kv-empty">Loading collections…</p>}
			{!loading && ordered.length === 0 && <p className="kv-empty">No collections yet. Create one to save requests.</p>}
			<div className="sidebar-scroll">
				<div className="tree">
					{ordered.map((collection, index) => {
						const open = expanded[collection._id] ?? false;
						const folders = collection.folders ?? [];
						const requests = collection.requests ?? [];
						const rootRequests = requests.filter((request) => !request.folderId);
						return (
							<div key={collection._id}>
								<div className={`tree-row ${activeCollectionId === collection._id ? "active" : ""}`}>
									<button
										aria-expanded={open}
										aria-label={`${open ? "Collapse" : "Expand"} ${collection.name}`}
										className="tree-toggle"
										type="button"
										onClick={() =>
											open
												? toggle(collection._id)
												: onOpenCollection(collection).then(() =>
														setExpanded((current) => ({ ...current, [collection._id]: true })),
													)
										}
									>
										<MaterialIcon size={18}>{open ? "expand_more" : "chevron_right"}</MaterialIcon>
									</button>
									<button
										className="tree-label"
										type="button"
										onClick={() =>
											onOpenCollection(collection).then(() =>
												setExpanded((current) => ({ ...current, [collection._id]: true })),
											)
										}
									>
										<MaterialIcon size={18}>folder_open</MaterialIcon>
										<span>{collection.name}</span>
									</button>
									<span className="tree-actions">
										<Menu
											items={[
												{
													disabled: index === 0,
													icon: "arrow_drop_up",
													label: "Move up",
													onSelect: () => onReorderCollection(collection._id, -1),
												},
												{
													disabled: index === ordered.length - 1,
													icon: "arrow_drop_down",
													label: "Move down",
													onSelect: () => onReorderCollection(collection._id, 1),
												},
												{ separator: true },
												{ icon: "add", label: "New folder", onSelect: () => onNewFolder(collection) },
												{ icon: "edit", label: "Rename", onSelect: () => onRenameCollection(collection) },
												{
													icon: "content_copy",
													label: "Duplicate",
													onSelect: () => onDuplicateCollection(collection),
												},
												{ separator: true },
												{
													danger: true,
													icon: "delete",
													label: "Delete collection",
													onSelect: () => onDeleteCollection(collection),
												},
											]}
											label={`Actions for ${collection.name}`}
										/>
									</span>
								</div>
								{open && (
									<div className="tree-children">
										{folders.map((folder) => (
											<div key={folder.id}>
												<div className="tree-row">
													<span style={{ width: 26 }} />
													<span className="tree-label">
														<MaterialIcon size={18}>folder</MaterialIcon>
														<span>{folder.name}</span>
													</span>
													<span className="tree-actions">
														<Menu
															items={[
																{
																	icon: "content_copy",
																	label: "Duplicate folder",
																	onSelect: () => onDuplicateFolder(collection, folder),
																},
																{
																	icon: "edit",
																	label: "Rename folder",
																	onSelect: () => onRenameFolder(collection, folder),
																},
																{ separator: true },
																{
																	danger: true,
																	icon: "delete",
																	label: "Delete folder",
																	onSelect: () => onDeleteFolder(collection, folder),
																},
															]}
															label={`Actions for ${folder.name}`}
														/>
													</span>
												</div>
												<div className="tree-children">
													{requests
														.filter((request) => request.folderId === folder.id)
														.map((request) => (
															<RequestRow
																active={activeRequestId === request.id}
																key={request.id}
																request={request}
																onDelete={(id) => onDeleteRequest(collection, id)}
																onDuplicate={(id) => onDuplicateRequest(collection, id)}
																onMove={(id, delta) => onMoveRequest(collection, id, delta)}
																onOpen={(item) => onOpenRequest(collection, item)}
															/>
														))}
													{requests.filter((request) => request.folderId === folder.id).length === 0 && (
														<p className="kv-empty">Empty folder</p>
													)}
												</div>
											</div>
										))}
										{rootRequests.map((request) => (
											<RequestRow
												active={activeRequestId === request.id}
												key={request.id}
												request={request}
												onDelete={(id) => onDeleteRequest(collection, id)}
												onDuplicate={(id) => onDuplicateRequest(collection, id)}
												onMove={(id, delta) => onMoveRequest(collection, id, delta)}
												onOpen={(item) => onOpenRequest(collection, item)}
											/>
										))}
										{requests.length === 0 && folders.length === 0 && (
											<p className="kv-empty">This collection has no requests yet.</p>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
