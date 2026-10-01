import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Menu } from "../../shared/components/Menu.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { TracerSymbol } from "../../shared/components/TracerBrand.jsx";
import { PRODUCT_SURFACES } from "../product/product-content.js";
import { ProfileAvatar } from "../profiles/ProfileAvatar.jsx";

export function WorkspaceHeader({
	account,
	environments,
	activeEnvironmentId,
	localRuntime,
	onEnvironmentChange,
	onOpenEnvironments,
	onOpenImport,
	onOpenLocalRuntime,
	onOpenChangeSafety,
	onOpenProof,
	onOpenProduct,
	onLogout,
	onToggleSidebar,
	onToggleTheme,
	profile,
	theme,
	workspaceCommand = null,
}) {
	const environmentOptions = [
		{ value: "", label: "No environment", hint: "Variables resolve from collection defaults" },
		...environments.map((environment) => ({
			value: environment._id,
			label: environment.name,
			hint: `revision ${environment.revision}`,
		})),
	];
	return (
		<header aria-label="Tracer commands" className="app-header">
			<div className="app-brand">
				<span className="brand-mark">
					<TracerSymbol size={24} />
				</span>
				<div>
					<strong>Tracer</strong>
					<br />
					<small>Execute · investigate · verify</small>
				</div>
			</div>
			<nav aria-label="Workspace commands" className="app-header-actions rail-primary">
				<button aria-label="Open collections" className="icon-button rail-command" title="Collections" type="button" onClick={onToggleSidebar}>
					<MaterialIcon size={21}>tune</MaterialIcon>
					<span className="rail-command-label">Collections</span>
				</button>
				<button aria-label="Import cURL" className="button rail-command" title="Import cURL" type="button" onClick={onOpenImport}>
					<MaterialIcon size={19}>description</MaterialIcon>
					<span className="rail-command-label">Import</span>
				</button>
				<button
					aria-label="Environments"
					className="button rail-command"
					title="Manage environments"
					type="button"
					onClick={onOpenEnvironments}
				>
					<MaterialIcon size={19}>edit</MaterialIcon>
					<span className="rail-command-label">Variables</span>
				</button>
				<button
					aria-label={`Local Runtime is ${localRuntime?.enabled ? "on" : "off"}`}
					aria-pressed={localRuntime?.enabled === true}
					className={`button rail-command ${localRuntime?.enabled ? "local-runtime-on" : ""}`}
					title="Local Runtime"
					type="button"
					onClick={onOpenLocalRuntime}
				>
					<MaterialIcon size={19}>{localRuntime?.enabled ? "warning" : "dns"}</MaterialIcon>
					<span className="rail-command-label">Runtime</span>
				</button>
			</nav>
			<div className="app-header-spacer" />
			<div className="app-header-actions rail-secondary">
				{workspaceCommand}
				<button
					aria-label="Open Change Safety"
					className="button rail-command"
					title="Change Safety"
					type="button"
					onClick={onOpenChangeSafety}
				>
					<MaterialIcon size={19}>rule</MaterialIcon>
					<span className="rail-command-label">Verify</span>
				</button>
				<button
					aria-label="View Verification Proof"
					className="button rail-command"
					title="View Verification Proof"
					type="button"
					onClick={onOpenProof}
				>
					<MaterialIcon size={19}>check</MaterialIcon>
					<span className="rail-command-label">Proof</span>
				</button>
				<SelectMenu
					ariaLabel="Active environment"
					className="environment-picker"
					options={environmentOptions}
					value={activeEnvironmentId ?? ""}
					onChange={onEnvironmentChange}
				/>
				<button
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="icon-button rail-command"
					title={`Use ${theme === "dark" ? "light" : "dark"} theme`}
					type="button"
					onClick={onToggleTheme}
				>
					<MaterialIcon size={19}>{theme === "dark" ? "light_mode" : "dark_mode"}</MaterialIcon>
					<span className="rail-command-label">Theme</span>
				</button>
				<Menu
					label="Help and product information"
					trigger="info"
					triggerClassName="icon-button rail-command"
					items={PRODUCT_SURFACES.map((surface) => ({
						label: surface.label,
						icon: surface.icon,
						onSelect: () => onOpenProduct(surface.id),
					}))}
				/>
				<button className="profile-chip" type="button" onClick={onLogout} title="Switch profile">
					<ProfileAvatar profile={profile} size="small" />
					<span className="profile-chip-text">
						<strong>{profile?.name ?? account?.name ?? "Profile"}</strong>
						<small>Signed in</small>
					</span>
				</button>
			</div>
		</header>
	);
}
