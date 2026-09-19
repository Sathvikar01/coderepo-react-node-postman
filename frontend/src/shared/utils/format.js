export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined) return "—";
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function formatTimestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return formatTimestamp(value);
}

export function statusClass(status) {
    if (!status) return "unknown";
    if (status < 300) return "success";
    if (status < 400) return "redirect";
    if (status < 500) return "warning";
    return "danger";
}

export const OUTCOME_LABELS = {
    response: "Completed",
    validation_error: "Not sent",
    network_error: "Connection failed",
    timeout: "Timed out",
    cancelled: "Cancelled",
    size_limit: "Too large",
    decode_error: "Decode failed",
    interrupted: "Interrupted",
};
