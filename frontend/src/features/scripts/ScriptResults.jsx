import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { phaseSummary, scriptConsoleEntries, scriptCounts, scriptTests, testDiagnostics, testStatusTone } from "./script-results.js";

const PHASES = [
	["Pre-request", "preRequest"],
	["Tests", "postResponse"],
];

const TEST_ICONS = { passed: "check_circle", failed: "cancel", error: "error" };

function PhaseRow({ label, phase }) {
	const summary = phaseSummary(phase);
	return (
		<div className="script-phase">
			<div className="script-phase-header">
				<span>{label}</span>
				<span className={`status-pill ${summary.tone}`}>{summary.label}</span>
			</div>
			{phase?.error && <span className="field-hint">{`${phase.error.code}: ${phase.error.message}`}</span>}
		</div>
	);
}

export function ScriptResults({ results }) {
	if (!results) return <p className="field-hint">This request has no pre-request or test scripts.</p>;
	const counts = scriptCounts(results);
	const tests = scriptTests(results);
	const consoleEntries = scriptConsoleEntries(results);
	return (
		<div className="script-results">
			<div className="script-summary">
				<span className="status-pill success">{counts.passed} passed</span>
				<span className="status-pill danger">{counts.failed} failed</span>
				<span className="status-pill warning">{counts.errors} error{counts.errors === 1 ? "" : "s"}</span>
			</div>
			{PHASES.map(([label, key]) => (
				<PhaseRow key={key} label={label} phase={results[key] ?? null} />
			))}
			{tests.length > 0 && (
				<ul className="script-test-list">
					{tests.map((test, index) => {
						const tone = testStatusTone(test.status);
						const diagnostics = testDiagnostics(test);
						return (
							<li key={`${test.name}-${index}`}>
								<MaterialIcon size={16}>{TEST_ICONS[tone]}</MaterialIcon>
								<span className={`script-test-name ${tone}`}>{test.name}</span>
								{test.message && <span className="field-hint">{test.message}</span>}
								{diagnostics && (
									<span className="script-test-diagnostics">
										{diagnostics.location && <span className="field-hint">{diagnostics.location}</span>}
										<span className="field-hint">
											expected <code>{diagnostics.expected ?? "\u2014"}</code>
										</span>
										<span className="field-hint">
											actual <code>{diagnostics.actual ?? "\u2014"}</code>
										</span>
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{consoleEntries.length > 0 && (
				<div className="script-phase">
					<div className="script-phase-header">
						<span>Console</span>
						<span className="field-hint">{consoleEntries.length} entr{consoleEntries.length === 1 ? "y" : "ies"}</span>
					</div>
					<pre className="script-console">
						{consoleEntries.map((entry, index) => `[${entry.phase}/${entry.level}] ${entry.message}`).join("\n")}
					</pre>
				</div>
			)}
		</div>
	);
}
