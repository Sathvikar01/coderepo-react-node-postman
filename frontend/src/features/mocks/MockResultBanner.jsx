import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { mockIndicator } from "./mock-run.js";

export function MockResultBanner({ mock, onCopyMockUrl }) {
	const indicator = mockIndicator(mock);
	if (!indicator) return null;
	return (
		<div className={`notice ${indicator.tone} mock-banner`} role="status">
			<MaterialIcon size={18}>{mock.matched ? "bolt" : "search_off"}</MaterialIcon>
			<span>
				<strong>{indicator.title}.</strong> {indicator.detail}
			</span>
			<button className="text-button" type="button" onClick={onCopyMockUrl}>
				Copy mock URL
			</button>
		</div>
	);
}
