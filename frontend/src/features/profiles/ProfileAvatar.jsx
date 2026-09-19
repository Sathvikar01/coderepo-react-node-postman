import { identityInitials } from "../../shared/utils/identity.js";

export function ProfileAvatar({ profile, size = "medium" }) {
    const name = profile?.name ?? "";
    return (
        <span aria-hidden="true" className={`profile-avatar ${size}`} style={{ background: profile?.avatarColor || "#1a73e8" }}>
            {identityInitials(name)}
        </span>
    );
}
