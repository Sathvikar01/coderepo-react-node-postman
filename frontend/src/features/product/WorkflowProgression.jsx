import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { workflowStepIndex } from "./product-content.js";

// Phase 48A — Signature-workflow progression strip.
//
// This is a *discoverability* affordance, not a wizard and not a control. It shows
// where the user is in a workflow, why the step exists, and what already exists,
// using only the step the caller passes in. It never gates navigation, never
// blocks a normal send, and never asserts a verification state — the backend
// stays authoritative for every state shown elsewhere.
//
// `currentStep` is the id of the step the user is viewing. Every other step is
// rendered as a passive landmark. A compact variant is used where space is tight.
export function WorkflowProgression({ workflow, currentStep = null, label = "Workflow", compact = false }) {
	if (!workflow || workflow.length === 0) return null;
	const currentIndex = currentStep ? workflowStepIndex(workflow, currentStep) : -1;
	const current = currentIndex >= 0 ? workflow[currentIndex] : null;
	return (
		<section aria-label={label} className={`workflow-progression ${compact ? "compact" : ""}`}>
			<ol className="workflow-steps">
				{workflow.map((step, index) => {
					const isCurrent = currentIndex === index;
					const isPast = currentIndex >= 0 && index < currentIndex;
					return (
						<li
							aria-current={isCurrent ? "step" : undefined}
							className={["workflow-step", isCurrent ? "current" : "", isPast ? "past" : ""].filter(Boolean).join(" ")}
							key={step.id}
						>
							<span aria-hidden="true" className="workflow-dot">
								{isPast ? <MaterialIcon size={12}>check</MaterialIcon> : index + 1}
							</span>
							<span className="workflow-step-label">{step.label}</span>
						</li>
					);
				})}
			</ol>
			{current && !compact && (
				<p className="workflow-current-hint">
					<strong>{current.label}</strong> — {current.hint}
				</p>
			)}
		</section>
	);
}
