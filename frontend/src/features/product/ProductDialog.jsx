import { useState } from "react";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { Modal } from "../../shared/components/Modal.jsx";
import { TracerSymbol } from "../../shared/components/TracerBrand.jsx";
import { useRovingTabs } from "../../shared/hooks/useRovingTabs.js";
import {
	CONCEPTS,
	CORE_STORY_FLOW,
	DATA_CATEGORIES,
	DATA_MINIMIZATION,
	DATA_NOTE,
	INVESTIGATION_WORKFLOW,
	INVESTIGATE_INTRO,
	PRODUCT_MODEL,
	PRODUCT_ONE_LINER,
	PRODUCT_SURFACES,
	PRODUCT_TAGLINE,
	QUICK_START,
	SECURITY_FACTS,
	SECURITY_NOTE,
	USAGE_NOTE,
	USAGE_TERMS,
	VERIFICATION_WORKFLOW,
	VERIFY_INTRO,
} from "./product-content.js";
import { WorkflowProgression } from "./WorkflowProgression.jsx";
import "./product.css";

// Phase 48A — Product identity surfaces: Getting Started, About, Security &
// Safety, Data Handling, and Responsible Use.
//
// These are in-product surfaces rendered with the existing modal conventions.
// They are presentation only:
//
//   * They describe behavior the repository actually implements. No claim here
//     asserts a certification, an audit, or a compliance status.
//   * They never render a verification state. Anything that looks like state is
//     a concept explanation, not the state of the user's workspace.
//
// Opening this from the header does not change any workspace state.

function SurfaceTabs({ activeId, onSelect, tabsRef }) {
	return (
		<div aria-label="Product information sections" className="product-tabs" onKeyDown={tabsRef.onKeyDown} ref={tabsRef.listRef} role="tablist">
			{PRODUCT_SURFACES.map((surface) => (
				<button
					aria-selected={activeId === surface.id}
					className="product-tab"
					key={surface.id}
					role="tab"
					tabIndex={activeId === surface.id ? 0 : -1}
					type="button"
					onClick={() => onSelect(surface.id)}
				>
					<MaterialIcon size={16}>{surface.icon}</MaterialIcon>
					{surface.label}
				</button>
			))}
		</div>
	);
}

function ModelGrid() {
	return (
		<div className="product-model-grid">
			{PRODUCT_MODEL.map((part) => (
				<article className="product-model-card" key={part.id}>
					<h4>{part.label}</h4>
					<p>{part.summary}</p>
					<p className="product-model-detail">{part.detail}</p>
					<ul className="product-chip-row">
						{part.surfaces.map((surface) => (
							<li className="product-chip" key={surface}>
								{surface}
							</li>
						))}
					</ul>
				</article>
			))}
		</div>
	);
}

function HelpSurface({ onSelect }) {
	return (
		<>
			<section className="product-section">
				<p className="product-lead">{PRODUCT_TAGLINE}. {PRODUCT_ONE_LINER}</p>
				<p className="product-note">
					Use this page as a map. Every step below opens a surface that already exists in the workspace.
				</p>
			</section>

			<section className="product-section">
				<h3>Quick start</h3>
				<ol className="product-steps">
					{QUICK_START.map((step, index) => (
						<li key={step.id}>
							<span aria-hidden="true" className="product-step-index">
								{index + 1}
							</span>
							<div>
								<strong>{step.title}</strong>
								<p>{step.body}</p>
							</div>
						</li>
					))}
				</ol>
			</section>

			<section className="product-section">
				<h3>What Tracer adds</h3>
				<ModelGrid />
			</section>

			<section className="product-section">
				<h3>Investigate a failure</h3>
				<p className="product-flow">{INVESTIGATE_INTRO.flow}</p>
				<WorkflowProgression workflow={INVESTIGATION_WORKFLOW} label="Investigation workflow" />
				<p className="product-note">{INVESTIGATE_INTRO.body}</p>
			</section>

			<section className="product-section">
				<h3>Verify a change</h3>
				<p className="product-flow">{VERIFY_INTRO.flow}</p>
				<WorkflowProgression label="Verification workflow" workflow={VERIFICATION_WORKFLOW} />
				<p className="product-note">{VERIFY_INTRO.body}</p>
			</section>

			<section className="product-section">
				<h3>Key concepts</h3>
				<dl className="product-concept-list">
					{Object.entries(CONCEPTS).map(([key, entry]) => (
						<div className="product-concept" key={key}>
							<dt>{entry.label}</dt>
							<dd>{entry.long}</dd>
						</div>
					))}
				</dl>
			</section>

			<section className="product-section">
				<div className="product-link-row">
					<button className="text-button" type="button" onClick={() => onSelect("security")}>
						<MaterialIcon size={16}>error_outline</MaterialIcon> Security &amp; Safety
					</button>
					<button className="text-button" type="button" onClick={() => onSelect("data")}>
						<MaterialIcon size={16}>folder</MaterialIcon> Data Handling
					</button>
					<button className="text-button" type="button" onClick={() => onSelect("usage")}>
						<MaterialIcon size={16}>edit</MaterialIcon> Responsible Use
					</button>
					<button className="text-button" type="button" onClick={() => onSelect("about")}>
						<MaterialIcon size={16}>info</MaterialIcon> About Tracer
					</button>
				</div>
			</section>
		</>
	);
}

function AboutSurface() {
	return (
		<>
			<section className="product-section product-about-head">
				<span className="product-about-mark">
					<TracerSymbol size={34} />
				</span>
				<div>
					<h3>Tracer</h3>
					<p className="product-lead">{PRODUCT_TAGLINE}</p>
				</div>
			</section>

			<section className="product-section">
				<p className="product-lead">{PRODUCT_ONE_LINER}</p>
			</section>

			<section className="product-section">
				<h3>Core workflow</h3>
				<p className="product-flow">{CORE_STORY_FLOW}</p>
				<ModelGrid />
			</section>

			<section className="product-section">
				<h3>Signature verification workflow</h3>
				<p className="product-flow">Edit → Snapshot → Impact → Drift → Rehearse → Contract Check → Verify → Proof</p>
				<WorkflowProgression label="Verification workflow" workflow={VERIFICATION_WORKFLOW} />
			</section>

			<section className="product-section">
				<h3>Why snapshots exist</h3>
				<p className="product-note">{CONCEPTS.snapshot.long}</p>
			</section>

			<section className="product-section">
				<h3>What Verification Proof means</h3>
				<p className="product-note">{CONCEPTS.proof.long}</p>
				<p className="product-note">{CONCEPTS.stale.long}</p>
			</section>

			<section className="product-section">
				<h3>Execution versus verification</h3>
				<div className="product-split">
					<article>
						<h4>Execution</h4>
						<p>
							Sending a request through the normal pipeline. It answers “what did this endpoint return just now?” and records a
							redacted history entry and passport.
						</p>
					</article>
					<article>
						<h4>Verification</h4>
						<p>
							Combining snapshot identity, environment drift, rehearsal outcome, and contract compatibility into a keyed, tamper-evident record. It
							answers “can I treat this exact state as known-good?” and never claims more than the evidence it cites.
						</p>
					</article>
				</div>
			</section>
		</>
	);
}

function SecuritySurface() {
	return (
		<>
			<section className="product-section">
				<p className="product-lead">
					How Tracer executes requests and what it does to keep a send bounded, secret-safe, and profile-scoped.
				</p>
			</section>
			<section className="product-section">
				<ul className="product-fact-list">
					{SECURITY_FACTS.map((fact) => (
						<li key={fact.id}>
							<strong>{fact.title}</strong>
							<p>{fact.body}</p>
						</li>
					))}
				</ul>
			</section>
			<section className="product-section">
				<p className="product-note product-note-strong">{SECURITY_NOTE}</p>
			</section>
		</>
	);
}

function DataSurface() {
	return (
		<>
			<section className="product-section">
				<p className="product-lead">What Tracer stores, and what it deliberately leaves out.</p>
			</section>
			<section className="product-section">
				<h3>Stored categories</h3>
				<dl className="product-concept-list">
					{DATA_CATEGORIES.map((category) => (
						<div className="product-concept" key={category.id}>
							<dt>{category.label}</dt>
							<dd>{category.body}</dd>
						</div>
					))}
				</dl>
			</section>
			<section className="product-section">
				<h3>Minimization in practice</h3>
				<ul className="product-bullet-list">
					{DATA_MINIMIZATION.map((item) => (
						<li key={item}>
							<MaterialIcon size={14}>check</MaterialIcon>
							<span>{item}</span>
						</li>
					))}
				</ul>
			</section>
			<section className="product-section">
				<p className="product-note product-note-strong">{DATA_NOTE}</p>
			</section>
		</>
	);
}

function UsageSurface() {
	return (
		<>
			<section className="product-section">
				<p className="product-lead">Tracer sends real HTTP requests. These are the practical rules for using it.</p>
			</section>
			<section className="product-section">
				<ul className="product-fact-list">
					{USAGE_TERMS.map((term) => (
						<li key={term.id}>
							<strong>{term.title}</strong>
							<p>{term.body}</p>
						</li>
					))}
				</ul>
			</section>
			<section className="product-section">
				<p className="product-note product-note-strong">{USAGE_NOTE}</p>
			</section>
		</>
	);
}

const SURFACE_BODY = {
	help: HelpSurface,
	about: AboutSurface,
	security: SecuritySurface,
	data: DataSurface,
	usage: UsageSurface,
};

const SURFACE_TITLE = {
	help: "Getting Started",
	about: "About Tracer",
	security: "Security & Safety",
	data: "Data Handling",
	usage: "Responsible Use",
};

// The product information dialog. `initialSurface` lets the Help menu open a
// specific page while keeping one accessible dialog and one focus contract.
// The roving tab keyboard contract is owned here, not by the caller.
export function ProductDialog({ initialSurface = "help", onClose }) {
	const [surface, setSurface] = useState(initialSurface);
	const tabs = useRovingTabs();
	const Body = SURFACE_BODY[surface] ?? HelpSurface;
	const title = SURFACE_TITLE[surface] ?? "Getting Started";
	return (
		<Modal className="product-modal" label={`Tracer — ${title}`} onClose={onClose}>
			<section className="form-dialog product-dialog">
				<header className="product-header">
					<div className="product-header-brand">
						<span className="brand-mark">
							<TracerSymbol size={22} />
						</span>
						<div>
							<p className="eyebrow">Tracer</p>
							<h2>{title}</h2>
						</div>
					</div>
					<button aria-label="Close product information" className="icon-button" data-autofocus type="button" onClick={onClose}>
						<MaterialIcon size={18}>close</MaterialIcon>
					</button>
				</header>

				<SurfaceTabs activeId={surface} onSelect={setSurface} tabsRef={tabs} />

				<div className="product-content" role="tabpanel" tabIndex={0}>
					<Body onSelect={setSurface} />
				</div>

				<footer>
					<button className="primary-button" type="button" onClick={onClose}>
						Close
					</button>
				</footer>
			</section>
		</Modal>
	);
}
