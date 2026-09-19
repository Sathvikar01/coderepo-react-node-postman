import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import { TracerSymbol } from "../../shared/components/TracerBrand.jsx";
import { ProfileAvatar } from "../profiles/ProfileAvatar.jsx";

export function WorkspaceHeader({
	account,
	environments,
	activeEnvironmentId,
	onEnvironmentChange,
	onOpenEnvironments,
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
				<button className="button" type="button" onClick={onOpenEnvironments}>
					<MaterialIcon size={18}>edit</MaterialIcon>
					<span className="button-label">Environments</span>
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
