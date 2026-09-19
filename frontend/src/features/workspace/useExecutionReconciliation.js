import { useCallback, useEffect, useRef } from "react";
import { executionApi } from "../executions/execution.api.js";

const RECONCILE_MAX_ATTEMPTS = 10;
const CANCEL_MAX_ATTEMPTS = 4;

// Owns the "the POST failed but the execution may still be running" recovery loop:
// bounded status polling after a dropped connection, and bounded cancel retries while
// admission settles. Every timer is tracked so unmount clears them.
export function useExecutionReconciliation({ dispatch, onTerminal, onStatus }) {
	const timers = useRef(new Map());

	const clearTimer = useCallback((executionId) => {
		const timer = timers.current.get(executionId);
		if (timer) {
			clearTimeout(timer);
			timers.current.delete(executionId);
		}
	}, []);

	useEffect(
		() => () => {
			timers.current.forEach((timer) => clearTimeout(timer));
			timers.current.clear();
		},
		[],
	);

	const reconcile = useCallback(
		(tabId, executionId) => {
			let attempts = 0;
			const finish = () => clearTimer(executionId);
			const poll = async () => {
				attempts += 1;
				try {
					const record = await executionApi.status(executionId);
					if (record.status === "terminal") {
						dispatch({ type: "draft/result", tabId, executionId, result: record });
						onTerminal?.();
						finish();
						return;
					}
				} catch (error) {
					if (error.code === "EXECUTION_NOT_FOUND" && attempts > 4) {
						dispatch({
							type: "draft/status",
							tabId,
							status: "error",
							error: "The application connection dropped before this send was recorded. It is unknown whether the target was reached.",
						});
						finish();
						return;
					}
				}
				if (attempts < RECONCILE_MAX_ATTEMPTS) {
					timers.current.set(executionId, setTimeout(poll, Math.min(400 * attempts, 3000)));
					return;
				}
				dispatch({
					type: "draft/status",
					tabId,
					status: "error",
					error: "This send is still unconfirmed. Check History for the recorded outcome, or send again with a new request.",
				});
				finish();
			};
			poll();
		},
		[clearTimer, dispatch, onTerminal],
	);

	const cancel = useCallback(
		async (tabId, executionId) => {
			let attempt = 0;
			const retry = async () => {
				attempt += 1;
				try {
					const result = await executionApi.cancel(executionId);
					if (result.status === "terminal") {
						dispatch({ type: "draft/result", tabId, executionId, result });
						onTerminal?.();
						return;
					}
				} catch (error) {
					if (error.code === "EXECUTION_NOT_FOUND" && attempt < 3) {
						timers.current.set(executionId, setTimeout(retry, 250 * attempt));
						return;
					}
				}
				if (attempt < CANCEL_MAX_ATTEMPTS) {
					timers.current.set(executionId, setTimeout(retry, 500 * attempt));
					return;
				}
				onStatus?.(tabId, "running");
			};
			retry();
		},
		[dispatch, onStatus, onTerminal],
	);

	return { reconcile, cancel, clearTimer };
}
