import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Menu } from "../../shared/components/Menu.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { roleLabel } from "./workspace-permissions.js";
import "./workspace.css";

// Phase 24 — the active-workspace control in the command rail.
//
// It is deliberately compact: one selector, one role badge, and one menu that
// reaches Manage / New / Activity. It never renders an admin dashboard, and it
// never claims access the backend has not granted.
export function WorkspaceSwitcher({
	activeWorkspaceId,
	capabilities,
	onCreate,
	onManage,
	onOpenActivity,
	onSelectWorkspace,
	role,
	workspaces,
}) {
	const options = workspaces.map((workspace) => ({
		value: workspace._id,
		label: workspace.name,
		hint: `${roleLabel(workspace.role)}${workspace.isPersonal ? " · personal" : ""}${
			workspace.memberCount > 1 ? ` · ${workspace.memberCount} members` : ""
		}`,
	}));
	const canManageMembers = capabilities?.manageMembers === true;
	const canRename = capabilities?.renameWorkspace === true;
	const canViewActivity = capabilities?.viewActivity === true;

	return (
		<div className="workspace-switcher">
			<SelectMenu
				ariaLabel="Active workspace"
				className="workspace-picker"
				disabled={options.length === 0}
				options={options.length > 0 ? options : [{ value: "", label: "No workspace" }]}
				value={activeWorkspaceId ?? ""}
				onChange={onSelectWorkspace}
			/>
			<span className="workspace-role-badge" data-role={role ?? "NONE"} title="Your role in this workspace">
				{roleLabel(role)}
			</span>
			<Menu
				items={[
					{ icon: "group", label: "Manage workspace…", onSelect: onManage },
					{
						icon: "add",
						label: "New workspace…",
						onSelect: onCreate,
					},
					{ separator: true },
					{
						disabled: !canViewActivity,
						icon: "history",
						label: "Workspace activity",
						onSelect: onOpenActivity,
					},
					{ separator: true },
					{
						disabled: !(canManageMembers || canRename),
						icon: "info",
						label: canManageMembers || canRename ? "You can manage this workspace" : "Viewer: read-only workspace",
						onSelect: onManage,
					},
				]}
				label="Workspace actions"
				trigger="workspaces"
				triggerClassName="icon-button rail-command"
			/>
		</div>
	);
}
