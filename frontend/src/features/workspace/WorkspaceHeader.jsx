import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { TracerSymbol } from "../../shared/components/TracerBrand.jsx";
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
	onLogout,
	onToggleSidebar,
	onToggleTheme,
	profile,
	theme,
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
		<header className="app-header">
			<button aria-label="Toggle collections panel" className="icon-button" type="button" onClick={onToggleSidebar}>
				<MaterialIcon size={22}>tune</MaterialIcon>
			</button>
			<div className="app-brand">
				<span className="brand-mark">
					<TracerSymbol size={24} />
				</span>
				<div>
					<strong>Tracer</strong>
					<br />
					<small>HTTP workspace</small>
				</div>
			</div>
			<div className="app-header-spacer" />
			<div className="app-header-actions">
				<SelectMenu
					ariaLabel="Active environment"
					className="environment-picker"
					options={environmentOptions}
					value={activeEnvironmentId ?? ""}
					onChange={onEnvironmentChange}
				/>
				<button aria-label="Import cURL" className="button" title="Import cURL" type="button" onClick={onOpenImport}>
					<MaterialIcon size={18}>content_paste_go</MaterialIcon>
					<span className="button-label">Import cURL</span>
				</button>
				<button className="button" type="button" onClick={onOpenEnvironments}>
					<MaterialIcon size={18}>edit</MaterialIcon>
					<span className="button-label">Environments</span>
				</button>
				<button
					aria-label={`Local Runtime is ${localRuntime?.enabled ? "on" : "off"}`}
					aria-pressed={localRuntime?.enabled === true}
					className={`button ${localRuntime?.enabled ? "local-runtime-on" : ""}`}
					title="Local Runtime: send to approved local development hosts"
					type="button"
					onClick={onOpenLocalRuntime}
				>
					<MaterialIcon size={18}>{localRuntime?.enabled ? "warning" : "dns"}</MaterialIcon>
					<span className="button-label">Local Runtime: {localRuntime?.enabled ? "On" : "Off"}</span>
				</button>
				<button
					aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
					className="icon-button"
					type="button"
					onClick={onToggleTheme}
				>
					<MaterialIcon size={20}>{theme === "dark" ? "light_mode" : "dark_mode"}</MaterialIcon>
				</button>
				<button className="profile-chip" type="button" onClick={onLogout} title="Switch profile or sign out">
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
