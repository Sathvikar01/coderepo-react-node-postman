import { useEffect, useRef } from "react";
import { apiHeaders, apiUrl } from "../../shared/api/client.js";

// Phase 24B — live workspace event stream over authenticated streaming fetch().
//
// The browser never uses bare EventSource (it cannot send Authorization or
// profile headers) and the token never appears in the URL. The stream carries
// metadata-only freshness signals; missed or dropped events are harmless because
// the client reloads canonical server state on reconnect.
//
// Behavior:
// - resumes after the last seen event id (in-memory ring on the server)
// - heartbeat watchdog: reconnects when no bytes arrive within 45s
// - bounded reconnect backoff: 1s doubling to 30s, only while mounted
// - terminal halt on 401/403/404 (signed out, removed, or deleted workspace)

const WATCHDOG_MS = 45000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

function parseSseBuffer(buffer, onEvent, seen) {
	// Split complete SSE frames (blank-line delimited); keep the partial tail.
	const frames = buffer.split("\n\n");
	const complete = frames.slice(0, -1);
	const rest = frames[frames.length - 1];
	for (const frame of complete) {
		let id = null;
		let event = null;
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("id: ")) id = line.slice(4).trim();
			else if (line.startsWith("event: ")) event = line.slice(7).trim();
			else if (line.startsWith("data: ")) data += line.slice(6);
		}
		if (!data || !event || event === "heartbeat") continue;
		if (id) seen.current = id;
		try {
			onEvent({ ...JSON.parse(data), id, action: event });
		} catch {
			// A malformed frame is advisory-only: drop it, keep the stream.
		}
	}
	return rest;
}

export function useWorkspaceEvents({ workspaceId, enabled, onEvent }) {
	const handler = useRef(onEvent);
	handler.current = onEvent;
	const seen = useRef(null);

	useEffect(() => {
		if (!workspaceId || !enabled) return undefined;
		let stopped = false;
		let backoff = BACKOFF_START_MS;
		let reader = null;
		let watchdog = null;
		seen.current = null;

		const bumpWatchdog = (reconnect) => {
			if (watchdog) clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				try {
					reader?.cancel();
				} catch {}
				reconnect();
			}, WATCHDOG_MS);
		};

		const connect = async () => {
			if (stopped) return;
			try {
				const query = seen.current ? `?lastEventId=${encodeURIComponent(seen.current)}` : "";
				const response = await fetch(apiUrl(`/workspaces/${workspaceId}/events${query}`), {
					headers: { Accept: "text/event-stream", ...apiHeaders() },
				});
				if (response.status === 401 || response.status === 403 || response.status === 404) {
					// Terminal: signed out, removed, or the workspace is gone. The
					// caller handles the state change; do not reconnect-loop.
					try {
						handler.current?.({ action: "stream.forbidden", status: response.status });
					} catch {}
					return;
				}
				if (!response.ok || !response.body) throw new Error(`Stream failed with ${response.status}.`);
				backoff = BACKOFF_START_MS;
				const decoder = new TextDecoder();
				reader = response.body.getReader();
				let buffer = "";
				bumpWatchdog(connect);
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					bumpWatchdog(connect);
					buffer = parseSseBuffer(buffer + decoder.decode(value, { stream: true }), (event) => handler.current?.(event), seen);
				}
			} catch {
				// Dropped connection: fall through to bounded reconnect.
			} finally {
				try {
					await reader?.cancel();
				} catch {}
				reader = null;
			}
			if (stopped) return;
			if (watchdog) clearTimeout(watchdog);
			const delay = backoff;
			backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			await new Promise((resolve) => setTimeout(resolve, delay));
			connect();
		};

		connect();
		return () => {
			stopped = true;
			if (watchdog) clearTimeout(watchdog);
			try {
				reader?.cancel();
			} catch {}
		};
	}, [workspaceId, enabled]);
}
