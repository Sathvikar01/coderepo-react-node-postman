import { Menu } from "../../shared/components/Menu.jsx";
import { roleLabel } from "./workspace-permissions.js";
import "./workspace.css";

// Collaboration belongs in the Phase-30 command rail, not in a second header.
// This component intentionally renders one icon command. Workspace selection,
// management, activity, and reviews live inside its menu so the Figma workbench
// keeps the original rail -> resource index -> canvas topology.
export function WorkspaceSwitcher({
	activeWorkspaceId,
	capabilities,
	onCreate,
	onManage,
	onOpenActivity,
	onOpenReviews,
	onSelectWorkspace,
	role,
	workspaces,
}) {
	const active = workspaces.find((workspace) => workspace._id === activeWorkspaceId) ?? null;
	const canManageMembers = capabilities?.manageMembers === true;
	const canRename = capabilities?.renameWorkspace === true;
	const canViewActivity = capabilities?.viewActivity === true;

	const workspaceItems = workspaces.map((workspace) => ({
		icon: workspace._id === activeWorkspaceId ? "check" : "workspaces",
		label: `${workspace.name} · ${roleLabel(workspace.role)}${workspace.isPersonal ? " · personal" : ""}`,
		onSelect: () => onSelectWorkspace(workspace._id),
	}));

	return (
		<Menu
			items={[
				{
					disabled: true,
					icon: "workspaces",
					label: active ? `Current: ${active.name} · ${roleLabel(role)}` : "No active workspace",
				},
				{ separator: true },
				...workspaceItems,
				{ separator: true },
				{ icon: "group", label: "Manage workspace…", onSelect: onManage },
				{ icon: "add", label: "New workspace…", onSelect: onCreate },
				{
					disabled: !canViewActivity,
					icon: "history",
					label: "Workspace activity",
					onSelect: onOpenActivity,
				},
				{ icon: "rate_review", label: "Reviews", onSelect: onOpenReviews },
				{ separator: true },
				{
					disabled: !(canManageMembers || canRename),
					icon: "info",
					label: canManageMembers || canRename ? "You can manage this workspace" : "Viewer: read-only workspace",
					onSelect: onManage,
				},
			]}
			label={active ? `Workspace: ${active.name}` : "Workspace"}
			side="right"
			trigger="workspaces"
			triggerClassName="icon-button rail-command"
		/>
	);
}
