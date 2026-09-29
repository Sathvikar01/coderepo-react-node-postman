import { useEffect, useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { WorkspaceActivityPanel } from "./WorkspaceActivityPanel.jsx";
import { ROLE_HINTS, WORKSPACE_ROLES, roleLabel } from "./workspace-permissions.js";

const roleOptions = WORKSPACE_ROLES.map((role) => ({ value: role, label: roleLabel(role), hint: ROLE_HINTS[role] }));

function CreateWorkspaceForm({ busy, error, onCancel, onCreate }) {
	const [name, setName] = useState("");
	return (
		<form
			className="form-dialog"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) onCreate(name.trim());
			}}
		>
			<h2>New workspace</h2>
			<div className="form-dialog-body">
				<p className="field-hint">
					A workspace groups collections and environments and can be shared with other Tracer users by email.
				</p>
				<label className="field">
					<span>Workspace name</span>
					<input
						data-autofocus
						maxLength={80}
						placeholder="API Platform Team"
						required
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				{error && (
					<p className="dialog-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<footer>
				<button className="button" disabled={busy} type="button" onClick={onCancel}>
					Cancel
				</button>
				<span style={{ flex: 1 }} />
				<button className="primary-button" disabled={busy || !name.trim()} type="submit">
					{busy ? "Creating…" : "Create workspace"}
				</button>
			</footer>
		</form>
	);
}

function MembersTab({ busy, capabilities, detail, onAddMember, onChangeRole, onRemoveMember, onRename }) {
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState("EDITOR");
	const [name, setName] = useState(detail?.name ?? "");

	useEffect(() => {
		setName(detail?.name ?? "");
	}, [detail?.name, detail?._id]);

	const canManageMembers = capabilities?.manageMembers === true;
	const canRename = capabilities?.renameWorkspace === true;
	const members = detail?.members ?? [];

	return (
		<div className="workspace-members">
			<form
				className="workspace-rename"
				onSubmit={(event) => {
					event.preventDefault();
					const trimmed = name.trim();
					if (canRename && trimmed && trimmed !== detail.name) onRename(trimmed);
				}}
			>
				<label className="field">
					<span>Workspace name</span>
					<input
						disabled={!canRename}
						maxLength={80}
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<button className="button" disabled={!canRename || busy || !name.trim() || name.trim() === detail.name} type="submit">
					Rename
				</button>
			</form>

			<div className="workspace-members-header">
				<strong>Members</strong>
				<small>
					{members.length} member{members.length === 1 ? "" : "s"} · revision {detail?.revision}
				</small>
			</div>

			{!canManageMembers && (
				<p className="field-hint" role="status">
					You can view this workspace, but only an owner can change members or roles.
				</p>
			)}

			<ul className="member-list">
				{members.map((member) => (
					<li className="member-row" key={member.profileId}>
						<span className="member-identity">
							<strong>
								{member.name}
								{member.isSelf ? " (you)" : ""}
							</strong>
							<small>{member.email ?? "email unavailable"}</small>
						</span>
						{canManageMembers ? (
							<SelectMenu
								ariaLabel={`Role for ${member.name}`}
								className="member-role"
								options={roleOptions}
								value={member.role}
								onChange={(role) => onChangeRole(member.profileId, role)}
							/>
						) : (
							<span className="member-role-static">{roleLabel(member.role)}</span>
						)}
						{canManageMembers && (
							<button
								aria-label={`Remove ${member.name}`}
								className="icon-button small"
								disabled={busy}
								title={`Remove ${member.name}`}
								type="button"
								onClick={() => onRemoveMember(member.profileId)}
							>
								<MaterialIcon size={18}>person_remove</MaterialIcon>
							</button>
						)}
					</li>
				))}
			</ul>

			{canManageMembers && (
				<form
					className="share-form"
					onSubmit={(event) => {
						event.preventDefault();
						const trimmed = email.trim();
						if (!trimmed) return;
						onAddMember(trimmed, inviteRole).then((ok) => {
							if (ok) setEmail("");
						});
					}}
				>
					<label className="field">
						<span>Share with an existing Tracer user</span>
						<input
							autoComplete="off"
							placeholder="name@example.test"
							spellCheck="false"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<SelectMenu
						ariaLabel="Role for the new member"
						className="member-role"
						options={roleOptions}
						value={inviteRole}
						onChange={setInviteRole}
					/>
					<button className="primary-button" disabled={busy || !email.trim()} type="submit">
						{busy ? "Sharing…" : "Share"}
					</button>
				</form>
			)}
		</div>
	);
}

// Phase 24 — the Manage Workspace surface.
//
// Members and activity live behind one dialog so the header rail stays clean.
// Permission state is expressed by disabling controls and explaining why, never
// by hiding the fact that the workspace is shared.
export function WorkspaceDialog({
	activityRefreshToken = 0,
	busy,
	capabilities,
	detail,
	error,
	mode,
	role,
	onAddMember,
	onCancel,
	onChangeRole,
	onCreate,
	onReload,
	onRemoveMember,
	onRename,
	onOpenVersions,
}) {
	const [tab, setTab] = useState(mode === "activity" ? "activity" : "members");

	useEffect(() => {
		setTab(mode === "activity" ? "activity" : "members");
	}, [mode, detail?._id]);

	if (mode === "create") {
		return (
			<Modal className="workspace-modal" label="New workspace" onClose={onCancel}>
				<CreateWorkspaceForm busy={busy} error={error} onCancel={onCancel} onCreate={onCreate} />
			</Modal>
		);
	}

	return (
		<Modal className="workspace-modal" label="Manage workspace" onClose={onCancel}>
			<section className="form-dialog">
				<h2>
					Manage workspace
					<span className="workspace-role-badge" data-role={role ?? "NONE"}>
						{roleLabel(role)}
					</span>
				</h2>
				<div aria-label="Workspace sections" className="editor-tabs workspace-tabs" role="tablist">
					<button
						aria-selected={tab === "members"}
						className="editor-tab"
						role="tab"
						tabIndex={tab === "members" ? 0 : -1}
						type="button"
						onClick={() => setTab("members")}
					>
						Members
					</button>
					<button
						aria-selected={tab === "activity"}
						className="editor-tab"
						role="tab"
						tabIndex={tab === "activity" ? 0 : -1}
						type="button"
						onClick={() => setTab("activity")}
					>
						Activity
					</button>
				</div>
				<div className="form-dialog-body">
					{!detail && !error && <p className="kv-empty">Loading workspace…</p>}
					{detail && tab === "members" && (
						<MembersTab
							busy={busy}
							capabilities={capabilities}
							detail={detail}
							onAddMember={onAddMember}
							onChangeRole={onChangeRole}
							onRemoveMember={onRemoveMember}
							onRename={onRename}
						/>
					)}
					{detail && tab === "activity" && (
						<div className="workspace-activity-tab">
							<WorkspaceActivityPanel
							refreshToken={activityRefreshToken}
							workspaceId={detail._id}
							onOpenVersions={onOpenVersions}
						/>
						</div>
					)}
					{error && (
						<p className="dialog-error" role="alert">
							{error}
						</p>
					)}
				</div>
				<footer>
					<button className="button" disabled={busy} type="button" onClick={onReload}>
						<MaterialIcon size={18}>refresh</MaterialIcon>
						Reload
					</button>
					<span style={{ flex: 1 }} />
					<button className="primary-button" type="button" onClick={onCancel}>
						Done
					</button>
				</footer>
			</section>
		</Modal>
	);
}
