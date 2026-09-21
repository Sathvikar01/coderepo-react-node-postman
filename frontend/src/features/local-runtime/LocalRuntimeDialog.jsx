import { useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { hostPayload, validateHostInput } from "./local-runtime.js";

export function LocalRuntimeDialog({ busy = false, error = "", localRuntime, onClose, onSave }) {
	const [draft, setDraft] = useState("");
	const [inputError, setInputError] = useState("");
	const targets = localRuntime.targets ?? [];
	const persist = ({ enabled = localRuntime.enabled, targets: nextTargets = hostPayload(targets) }) =>
		onSave({ enabled, targets: nextTargets });

	const addHost = () => {
		const result = validateHostInput(draft, targets.map((target) => target.host));
		if (!result.ok) {
			setInputError(result.error);
			return;
		}
		setInputError("");
		setDraft("");
		persist({ targets: [...hostPayload(targets), { host: result.host }] });
	};

	return (
		<Modal className="form-dialog-modal" label="Local Runtime" onClose={onClose}>
			<section className="form-dialog">
				<h2>Local Runtime</h2>
				<div className="form-dialog-body">
					<p className="field-hint">
						Local Runtime is off by default. When it is on, this profile can send requests to the exact loopback and private
						LAN hosts approved below. Cloud metadata endpoints and every other private target stay blocked.
					</p>
					<label className="local-runtime-toggle">
						<input
							checked={localRuntime.enabled}
							disabled={busy}
							type="checkbox"
							onChange={() => persist({ enabled: !localRuntime.enabled })}
						/>
						<span>{localRuntime.enabled ? "Local Runtime is on" : "Local Runtime is off"}</span>
					</label>
					{localRuntime.enabled && (
						<div className="notice warning">
							Requests to approved hosts are sent from this server, marked as local access in the response and in History.
						</div>
					)}
					<div className="field-row">
						<label htmlFor="local-runtime-host">Approve a host</label>
						<div className="local-runtime-add">
							<input
								id="local-runtime-host"
								placeholder="dev.lan, 127.0.0.1, ::1"
								type="text"
								value={draft}
								onChange={(event) => {
									setDraft(event.target.value);
									setInputError("");
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										addHost();
									}
								}}
							/>
							<button className="button" disabled={busy || !draft.trim()} type="button" onClick={addHost}>
								<MaterialIcon size={18}>add</MaterialIcon>
								<span className="button-label">Approve</span>
							</button>
						</div>
					</div>
					{inputError && <div className="dialog-error">{inputError}</div>}
					<ul className="local-runtime-targets">
						{targets.length === 0 && <li className="kv-empty">No approved hosts yet. Local Runtime stays inactive until one is added.</li>}
						{targets.map((target) => (
							<li key={target.id}>
								<code>{target.host}</code>
								<button
									aria-label={`Remove ${target.host}`}
									className="icon-button small"
									disabled={busy}
									type="button"
									onClick={() => persist({ targets: hostPayload(targets.filter((item) => item.id !== target.id)) })}
								>
									<MaterialIcon size={16}>close</MaterialIcon>
								</button>
							</li>
						))}
					</ul>
					{error && <div className="dialog-error">{error}</div>}
				</div>
				<footer>
					<span style={{ flex: 1 }} />
					<button className="primary-button" disabled={busy} type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</section>
		</Modal>
	);
}
