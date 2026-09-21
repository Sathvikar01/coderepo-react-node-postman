import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";

export function ExampleActions({ busy = false, canSave = false, mockRoute = "", onCopyMockUrl, onMockSend, onSaveExample }) {
	return (
		<div className="example-actions" role="group" aria-label="Examples and mocks">
			<button className="button" disabled={!canSave || busy} type="button" onClick={onSaveExample}>
				<MaterialIcon size={18}>bookmark_add</MaterialIcon>
				<span className="button-label">Save as example</span>
			</button>
			<button className="button" disabled={busy} type="button" onClick={onMockSend}>
				<MaterialIcon size={18}>bolt</MaterialIcon>
				<span className="button-label">{busy ? "Mocking…" : "Mock Send"}</span>
			</button>
			<button className="button" disabled={!mockRoute} type="button" onClick={onCopyMockUrl}>
				<MaterialIcon size={18}>link</MaterialIcon>
				<span className="button-label">Copy mock URL</span>
			</button>
			<span className="field-hint">Mock Send is explicit: Send always uses the real execution pipeline.</span>
		</div>
	);
}
