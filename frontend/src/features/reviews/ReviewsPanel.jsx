import { useCallback, useEffect, useMemo, useState } from "react";
import { reviewsApi } from "./reviews.api.js";
import { workspaceApi } from "../workspaces/workspace.api.js";
import "./reviews.css";

// Phase 50 — Reviews / Needs Attention surface.
//
// One workspace surface, not a project-management dashboard. It lists review
// rows (id, finding, technical state, assignee, reviewer, decision, freshness,
// updated time) and opens a detail view with four sections:
// Finding | Evidence | Discussion | Decision.
//
// Technical truth separation is rendered, not just documented: every decision
// control shows BOTH the frozen technical state and the human decision, and a
// waiver is labelled as a waiver — never as VERIFIED.

const FINDING_TYPES = [
	"contract_breaking",
	"verification_blocked",
	"verification_unknown",
	"drift_blocking",
	"drift_unknown",
	"impact_unresolved",
	"rehearsal_failure",
	"verification_proof",
	"why_evidence",
];

function shortId(id) {
	const value = String(id ?? "");
	return value.length > 8 ? `…${value.slice(-6)}` : value || "—";
}

function formatTime(value) {
	try {
		return new Date(value).toLocaleString();
	} catch {
		return String(value ?? "—");
	}
}

function memberLabel(member) {
	if (!member) return "Nobody";
	return `${shortId(member.profileId)} · ${member.role}`;
}

export function ReviewsPanel({ workspaceId, profileId, role, onToast, liveTick }) {
	const [reviews, setReviews] = useState([]);
	const [members, setMembers] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [selectedId, setSelectedId] = useState(null);
	const [showPromote, setShowPromote] = useState(false);

	const canMutate = role === "OWNER" || role === "EDITOR";

	const reload = useCallback(async () => {
		if (!workspaceId) return;
		setLoading(true);
		setError("");
		try {
			const [list, workspace] = await Promise.all([reviewsApi.list(), workspaceApi.get(workspaceId)]);
			setReviews(list?.data ?? list ?? []);
			setMembers(workspace?.data?.members ?? workspace?.members ?? []);
		} catch (loadError) {
			setError(loadError.message);
		} finally {
			setLoading(false);
		}
	}, [workspaceId]);

	useEffect(() => {
		reload();
	}, [reload, liveTick]);

	const summary = useMemo(() => {
		const open = reviews.filter((item) => item.status !== "CLOSED");
		return {
			breaking: open.filter((item) => item.technicalState === "BREAKING").length,
			blocked: open.filter((item) => item.technicalState === "BLOCKED").length,
			mine: open.filter((item) => String(item.assigneeProfileId) === String(profileId)).length,
		};
	}, [reviews, profileId]);

	const selected = reviews.find((item) => String(item._id) === String(selectedId)) ?? null;

	return (
		<div className="sidebar-panel reviews-panel">
			<div className="sidebar-section-label">
				<span>Needs attention</span>
				{canMutate && (
					<button className="link-button" type="button" onClick={() => setShowPromote(true)}>
						Promote to review
					</button>
				)}
			</div>
			<p className="reviews-summary" role="status">
				{summary.breaking} breaking · {summary.blocked} blocked · {summary.mine} assigned to you
			</p>
			{loading ? (
				<p className="reviews-empty">Loading reviews…</p>
			) : error ? (
				<p className="reviews-error" role="alert">
					{error}
				</p>
			) : reviews.length === 0 ? (
				<p className="reviews-empty">No reviews yet. Promote a breaking contract, blocked verification, or failed rehearsal to start one.</p>
			) : (
				<ul className="reviews-list">
					{reviews.map((item) => (
						<li key={item._id}>
							<button
								className={`reviews-row${String(item._id) === String(selectedId) ? " selected" : ""}`}
								type="button"
								onClick={() => setSelectedId(item._id)}
							>
								<span className="reviews-row-id">{item.displayId}</span>
								<span className="reviews-row-title">{item.title}</span>
								<span className="reviews-row-meta">
									<span className={`pill technical ${String(item.technicalState).toLowerCase()}`}>{item.technicalState}</span>
									<span className={`pill decision ${String(item.decision).toLowerCase()}`}>{item.decision}</span>
									<span className={`pill freshness ${String(item.freshness).toLowerCase()}`}>{item.freshness}</span>
								</span>
								<span className="reviews-row-sub">
									{item.findingType} · {memberLabel(members.find((m) => String(m.profileId) === String(item.assigneeProfileId)))} ·{" "}
									{formatTime(item.updatedAt)}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{selected && (
				<ReviewDetail
					key={selected._id}
					members={members}
					profileId={profileId}
					review={selected}
					role={role}
					onBack={() => setSelectedId(null)}
					onChanged={reload}
					onToast={onToast}
				/>
			)}
			{showPromote && (
				<PromoteForm
					members={members}
					onClose={() => setShowPromote(false)}
					onCreated={(created) => {
						setShowPromote(false);
						setSelectedId(created._id);
						reload();
					}}
					onToast={onToast}
				/>
			)}
		</div>
	);
}

function ReviewDetail({ members, onBack, onChanged, onToast, profileId, review, role }) {
	const [detail, setDetail] = useState(review);
	const [comments, setComments] = useState([]);
	const [audit, setAudit] = useState([]);
	const [busy, setBusy] = useState(false);
	const [commentBody, setCommentBody] = useState("");
	const [mentionId, setMentionId] = useState("");
	const [waiveReason, setWaiveReason] = useState("");
	const [changeReason, setChangeReason] = useState("");

	const reloadDetail = useCallback(async () => {
		try {
			const [fresh, thread, trail] = await Promise.all([
				reviewsApi.get(review._id),
				reviewsApi.comments(review._id),
				reviewsApi.audit(review._id),
			]);
			setDetail(fresh?.data ?? fresh);
			setComments(thread?.data ?? thread ?? []);
			setAudit(trail?.data ?? trail ?? []);
			onChanged();
		} catch (loadError) {
			onToast?.(loadError.message, "error");
		}
	}, [review._id, onChanged, onToast]);

	useEffect(() => {
		reloadDetail();
	}, [reloadDetail]);

	async function run(label, operation) {
		setBusy(true);
		try {
			await operation();
			await reloadDetail();
			if (label) onToast?.(label, "success");
		} catch (operationError) {
			onToast?.(operationError.message, "error");
		} finally {
			setBusy(false);
		}
	}

	const isOwner = role === "OWNER";
	const assignee = members.find((m) => String(m.profileId) === String(detail.assigneeProfileId));
	const reviewer = members.find((m) => String(m.profileId) === String(detail.reviewerProfileId));

	return (
		<div className="review-detail" role="dialog" aria-label={`Review ${detail.displayId}`}>
			<button className="link-button" type="button" onClick={onBack}>
				← All reviews
			</button>
			<h3>
				{detail.displayId} · {detail.title}
			</h3>

			<section aria-label="Finding">
				<h4>Finding</h4>
				<p>{detail.findingSummary}</p>
				<p className="truth-line">
					Technical state: <strong>{detail.technicalState}</strong> · Human decision: <strong>{detail.decision}</strong>
					{detail.freshness === "STALE" && (
						<span className="pill freshness stale"> STALE{(detail.staleChangedFields ?? []).length > 0 ? ` (${detail.staleChangedFields.join(", ")})` : ""}</span>
					)}
				</p>
			</section>

			<section aria-label="Evidence">
				<h4>Evidence (frozen)</h4>
				<dl className="evidence-list">
					{Object.entries(detail.evidence ?? {}).map(([key, value]) => (
						<div key={key}>
							<dt>{key}</dt>
							<dd>{Array.isArray(value) ? value.join(", ") : String(value ?? "—")}</dd>
						</div>
					))}
				</dl>
				<p className="fingerprint-line">Evidence fingerprint: {shortId(detail.evidenceFingerprint)}</p>
			</section>

			<section aria-label="Discussion">
				<h4>Discussion</h4>
				<ul className="review-comments">
					{comments.map((comment) => (
						<li key={comment._id}>
							<span className="comment-author">{shortId(comment.authorProfileId)}</span>{" "}
							<span className="comment-time">{formatTime(comment.createdAt)}</span>
							<p>{comment.body}</p>
							{(comment.mentions ?? []).length > 0 && <p className="comment-mentions">Mentioned: {comment.mentions.map(shortId).join(", ")}</p>}
						</li>
					))}
				</ul>
				{role !== "VIEWER" && (
					<div className="comment-form">
						<label>
							Comment
							<textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} rows={3} maxLength={2000} />
						</label>
						<label>
							Mention a member
							<select value={mentionId} onChange={(event) => setMentionId(event.target.value)}>
								<option value="">Nobody</option>
								{members.map((member) => (
									<option key={member.profileId} value={member.profileId}>
										{memberLabel(member)}
									</option>
								))}
							</select>
						</label>
						<button
							disabled={busy || !commentBody.trim()}
							type="button"
							onClick={() => run("Comment added.", () => reviewsApi.addComment(detail._id, commentBody.trim(), mentionId ? [mentionId] : []).then(() => {
								setCommentBody("");
								setMentionId("");
							}))}
						>
							Add comment
						</button>
					</div>
				)}
			</section>

			<section aria-label="Decision">
				<h4>Decision</h4>
				<p>
					Assignee: {memberLabel(assignee)} · Reviewer: {memberLabel(reviewer)} · Status: {detail.status}
				</p>
				{detail.decision === "WAIVED" && detail.waiver && (
					<p className="waiver-box" role="note">
						Waived by {shortId(detail.waiver.authorProfileId)} at {formatTime(detail.waiver.waivedAt)} — technical state remains{" "}
						<strong>{detail.waiver.technicalState}</strong>. Reason: {detail.waiver.reason}
					</p>
				)}
				<div className="decision-actions">
					{isOwner && detail.status === "OPEN" && (
						<button disabled={busy} type="button" onClick={() => run("Review started.", () => reviewsApi.setStatus(detail._id, detail.revision, "IN_REVIEW"))}>
							Start review
						</button>
					)}
					{role !== "VIEWER" && (
						<button disabled={busy} type="button" onClick={() => run("Approved. Technical state unchanged.", () => reviewsApi.decide(detail._id, detail.revision, "APPROVED"))}>
							Approve
						</button>
					)}
					{role !== "VIEWER" && (
						<div className="decision-reason-row">
							<input
								aria-label="Change request reason"
								maxLength={500}
								placeholder="Reason (optional)"
								value={changeReason}
								onChange={(event) => setChangeReason(event.target.value)}
							/>
							<button
								disabled={busy}
								type="button"
								onClick={() => run("Changes requested.", () => reviewsApi.decide(detail._id, detail.revision, "CHANGES_REQUESTED", changeReason || undefined).then(() => setChangeReason("")))}
							>
								Request changes
							</button>
						</div>
					)}
					{isOwner && (
						<div className="decision-reason-row">
							<input
								aria-label="Waiver reason"
								maxLength={500}
								placeholder="Waiver reason (required)"
								value={waiveReason}
								onChange={(event) => setWaiveReason(event.target.value)}
							/>
							<button
								disabled={busy || !waiveReason.trim()}
								type="button"
								onClick={() => run("Waived. Technical state unchanged.", () => reviewsApi.waive(detail._id, detail.revision, waiveReason.trim()).then(() => setWaiveReason("")))}
							>
								Waive
							</button>
						</div>
					)}
					{isOwner && detail.status !== "CLOSED" && (
						<button disabled={busy} type="button" onClick={() => run("Review closed.", () => reviewsApi.close(detail._id, detail.revision))}>
							Resolve
						</button>
					)}
					<button disabled={busy} type="button" onClick={() => run("Freshness rechecked.", () => reviewsApi.refresh(detail._id, {}))}>
						Recheck freshness
					</button>
					{isOwner && (
						<button
							disabled={busy}
							type="button"
							onClick={() =>
								run("Re-review created from current evidence.", async () => {
									const created = await reviewsApi.rereview(detail._id, {});
									const next = created?.data ?? created;
									if (next?._id) window.location.hash = `#review-${next._id}`;
								})
							}
						>
							Create re-review
						</button>
					)}
				</div>
			</section>

			<section aria-label="Audit trail">
				<h4>Audit trail</h4>
				<ul className="review-audit">
					{audit.map((entry) => (
						<li key={entry._id}>
							{entry.action} · {shortId(entry.actorProfileId)} · {formatTime(entry.createdAt)} — {entry.summary}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}

function PromoteForm({ members, onClose, onCreated, onToast }) {
	const [title, setTitle] = useState("");
	const [findingType, setFindingType] = useState(FINDING_TYPES[0]);
	const [findingSummary, setFindingSummary] = useState("");
	const [technicalState, setTechnicalState] = useState("BREAKING");
	const [resourceType, setResourceType] = useState("collection");
	const [resourceId, setResourceId] = useState("");
	const [revision, setRevision] = useState("");
	const [assigneeProfileId, setAssigneeProfileId] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(event) {
		event.preventDefault();
		setBusy(true);
		try {
			const created = await reviewsApi.create({
				title: title.trim(),
				findingType,
				findingSummary: findingSummary.trim(),
				technicalState: technicalState.trim() || "UNKNOWN",
				evidence: {
					...(resourceId.trim() ? { resourceType, resourceId: resourceId.trim() } : {}),
					...(revision ? { revision: Number(revision) } : {}),
					technicalState: technicalState.trim() || "UNKNOWN",
				},
				...(assigneeProfileId ? { assigneeProfileId } : {}),
			});
			onCreated(created?.data ?? created);
			onToast?.("Review promoted with frozen evidence.", "success");
		} catch (submitError) {
			onToast?.(submitError.message, "error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="review-detail promote-form" onSubmit={submit} aria-label="Promote to review">
			<h3>Promote to review</h3>
			<p className="promote-hint">Explicit creation only. The review binds the exact evidence you name and never auto-sends, auto-saves, or re-executes.</p>
			<label>
				Title
				<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required />
			</label>
			<label>
				Finding type
				<select value={findingType} onChange={(event) => setFindingType(event.target.value)}>
					{FINDING_TYPES.map((type) => (
						<option key={type} value={type}>
							{type}
						</option>
					))}
				</select>
			</label>
			<label>
				Finding summary
				<textarea value={findingSummary} onChange={(event) => setFindingSummary(event.target.value)} rows={3} maxLength={1000} required />
			</label>
			<label>
				Technical state (frozen, never rewritten by decisions)
				<input value={technicalState} onChange={(event) => setTechnicalState(event.target.value)} maxLength={40} required />
			</label>
			<div className="promote-row">
				<label>
					Resource type
					<select value={resourceType} onChange={(event) => setResourceType(event.target.value)}>
						<option value="collection">collection</option>
						<option value="environment">environment</option>
					</select>
				</label>
				<label>
					Resource id
					<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} maxLength={120} placeholder="optional" />
				</label>
				<label>
					Revision
					<input value={revision} onChange={(event) => setRevision(event.target.value)} inputMode="numeric" placeholder="optional" />
				</label>
			</div>
			<label>
				Assignee
				<select value={assigneeProfileId} onChange={(event) => setAssigneeProfileId(event.target.value)}>
					<option value="">Nobody</option>
					{members.map((member) => (
						<option key={member.profileId} value={member.profileId}>
							{memberLabel(member)}
						</option>
					))}
				</select>
			</label>
			<div className="decision-actions">
				<button disabled={busy} type="submit">
					Promote
				</button>
				<button disabled={busy} type="button" onClick={onClose}>
					Cancel
				</button>
			</div>
		</form>
	);
}
