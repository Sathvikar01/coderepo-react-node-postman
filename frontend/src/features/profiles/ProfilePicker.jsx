import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { ProfileAvatar } from "./ProfileAvatar.jsx";

export function ProfilePicker({ error = "", loading = false, onLogout, onRetry, onSelect, profiles = [], switchingFrom = null }) {
    return (
        <main className="profile-picker-page">
            <section aria-labelledby="profile-picker-title" className="profile-picker-card">
                <div className="profile-picker-mark"><span className="brand-mark">RD</span></div>
                <h1 id="profile-picker-title">Choose a profile</h1>
                <p className="profile-picker-subtitle">to continue to Request Desk</p>
                {switchingFrom && <p className="profile-picker-current">Signed in as {switchingFrom.name}</p>}
                {loading && (
                    <div className="profile-picker-status" role="status"><span className="profile-loader" />Loading profiles…</div>
                )}
                {!loading && error && (
                    <div className="profile-picker-error" role="alert">
                        <div><strong>Profiles couldn’t be loaded</strong><span>{error}</span></div>
                        <button type="button" onClick={onRetry}>Try again</button>
                    </div>
                )}
                {!loading && !error && (
                    <ul className="profile-account-list">
                        {profiles.map((profile) => (
                            <li key={profile._id}>
                                <button aria-label={`Continue as ${profile.name}`} className="profile-account" type="button" onClick={() => onSelect(profile)}>
                                    <ProfileAvatar profile={profile} size="small" />
                                    <span><strong>{profile.name}</strong><small>{profile.email}</small></span>
                                </button>
                            </li>
                        ))}
                        <li>
                            <button className="profile-account profile-account-signout" type="button" onClick={onLogout}>
                                <span className="icon-button"><MaterialIcon size={20}>logout</MaterialIcon></span>
                                <span><strong>Sign out of workspace</strong></span>
                            </button>
                        </li>
                    </ul>
                )}
                {!loading && !error && profiles.length === 0 && <div className="profile-picker-status">No profiles are available for this account.</div>}
            </section>
            <footer className="workspace-login-footer"><span>English (United States)</span><span>Local evaluation build</span></footer>
        </main>
    );
}
