import mongoose from "mongoose";
import { AppError } from "../../shared/errors/app-error.js";
import {
	CONTRACT_KIND,
	CONTRACT_SCHEMA_VERSION,
	CONTRACT_STATE,
	CONTRACT_LIMITS,
	parseContractDraftInput,
	parseContractUpdateInput,
	parseStoredContract,
} from "./contract-schema.js";
import { contractFingerprint, contractFingerprintKeyId } from "./contract-canonical.js";
import { contentEqual, assertMutable } from "./contract-lifecycle.js";
import { contractRepository } from "./contract.repository.js";

// Phase 42A — API contract registry service.
//
// Owns the lifecycle decisions and the identity checks; the repository owns
// persistence and the schema owns validation. The service is written against an
// injected repository so its behaviour can be exercised without a database, which
// is also what makes the concurrency and idempotency behaviour testable.
//
// What this service deliberately does NOT do: compare a contract to a live
// execution, detect breaking changes, run anything, or integrate with the runner.
// It stores and validates expected response behaviour.

function assertProfileId(ownerProfileId) {
	if (!ownerProfileId) throw new AppError(401, "CONTRACT_PROFILE_REQUIRED", "A profile is required to manage contracts.");
	return String(ownerProfileId);
}

function assertObjectId(value, code, message) {
	if (!mongoose.isValidObjectId(value)) throw new AppError(404, code, message);
}

// Build the persisted content document from parsed input. The stored shape is the
// validated one, so what is written is exactly what the schema accepted.
function contentFrom(input) {
	return {
		schemaVersion: CONTRACT_SCHEMA_VERSION,
		kind: CONTRACT_KIND,
		provenance: input.provenance,
		name: input.name,
		description: input.description ?? "",
		body: {
			status: input.body.status ?? null,
			statuses: [...(input.body.statuses ?? [])].sort((left, right) => left - right),
			headers: (input.body.headers ?? []).map((header) => ({
				name: header.name,
				value: header.value ?? null,
				required: Boolean(header.required),
			})),
			bodyType: input.body.bodyType ?? null,
			body: input.body.body ?? null,
		},
	};
}

function newContractId() {
	return `contract_${new mongoose.Types.ObjectId().toHexString()}`;
}

// A stable, caller-supplied contract id is used when given, so a caller can pin a
// contract's identity across versions and across machines.
function resolveContractId(requested) {
	if (requested === undefined || requested === null) return newContractId();
	const value = String(requested).trim();
	if (!value) throw new AppError(400, "CONTRACT_INVALID", "A contract identifier cannot be empty.");
	return value;
}

export function createContractRegistryService({ repository = contractRepository, now = () => new Date(), actor = null } = {}) {
	// -----------------------------------------------------------------------
	// Create a DRAFT
	// -----------------------------------------------------------------------
	async function createDraft(ownerProfileId, input) {
		const profileId = assertProfileId(ownerProfileId);
		const parsed = parseContractDraftInput(input);
		if (parsed.collectionId) assertObjectId(parsed.collectionId, "CONTRACT_COLLECTION_NOT_FOUND", "The collection does not exist.");
		if (parsed.workspaceId) assertObjectId(parsed.workspaceId, "CONTRACT_WORKSPACE_NOT_FOUND", "The workspace does not exist.");

		const content = contentFrom(parsed);
		// Validate what will be persisted against the stored-document contract, so a
		// stored row can never disagree with the read path.
		parseStoredContract(content);

		const contractId = resolveContractId(parsed.contractId);
		const sequence = await repository.allocateSequence(profileId, contractId);
		const contentFingerprint = contractFingerprint(content);

		const document = {
			ownerProfileId: profileId,
			collectionId: parsed.collectionId ?? null,
			workspaceId: parsed.workspaceId ?? null,
			requestId: parsed.requestId,
			snapshotId: parsed.snapshotId ?? null,
			snapshotFingerprint: parsed.snapshotFingerprint ?? null,
			contractId,
			sequence,
			state: CONTRACT_STATE.DRAFT,
			contentFingerprint,
			fingerprintKeyId: contractFingerprintKeyId(),
			content,
			createdBy: actor,
			publishedBy: null,
			publishedAt: null,
		};

		return repository.insertVersion(document);
	}

	// -----------------------------------------------------------------------
	// Replace a DRAFT (drafts are the only mutable state)
	// -----------------------------------------------------------------------
	async function updateDraft(ownerProfileId, contractId, sequence, patch) {
		const profileId = assertProfileId(ownerProfileId);
		const existing = await requireVersion(profileId, contractId, sequence);
		assertMutable(existing);

		const parsed = parseContractUpdateInput({
			...projectToInput(existing),
			...patch,
			// Identity fields are not patchable through an edit; a different request or
			// workspace is a different contract.
			requestId: existing.requestId,
		});

		const content = contentFrom(parsed);
		parseStoredContract(content);
		const contentFingerprint = contractFingerprint(content);

		const updated = await repository.replaceDraftContent(profileId, contractId, sequence, {
			content,
			contentFingerprint,
			fingerprintKeyId: contractFingerprintKeyId(),
			collectionId: parsed.collectionId ?? null,
			workspaceId: parsed.workspaceId ?? null,
			snapshotId: parsed.snapshotId ?? null,
			snapshotFingerprint: parsed.snapshotFingerprint ?? null,
		});
		// The repository's state filter is the real guard; a null result means the row
		// left the DRAFT state between the read and the write.
		if (!updated) throw new AppError(409, "CONTRACT_IMMUTABLE", "The contract changed while it was being edited.");
		return updated;
	}

	// -----------------------------------------------------------------------
	// Discard a DRAFT
	// -----------------------------------------------------------------------
	async function discardDraft(ownerProfileId, contractId, sequence) {
		const profileId = assertProfileId(ownerProfileId);
		const existing = await requireVersion(profileId, contractId, sequence);
		assertMutable(existing);
		const removed = await repository.deleteDraft(profileId, contractId, sequence);
		if (!removed) throw new AppError(409, "CONTRACT_IMMUTABLE", "The contract is no longer a draft.");
		return removed;
	}

	// -----------------------------------------------------------------------
	// Publish
	// -----------------------------------------------------------------------
	//
	// Publishing is where the interesting semantics live:
	//
	//   * Publishing an already-published version is idempotent: it returns the
	//     existing row unchanged rather than erroring or duplicating it.
	//   * Publishing content identical to the currently published version for the
	//     same request is idempotent too: no new version is stored, and the caller is
	//     told it was a no-op.
	//   * A newer published version supersedes the previous one for the same
	//     request, and the superseded row remains readable.
	async function publish(ownerProfileId, contractId, sequence) {
		const profileId = assertProfileId(ownerProfileId);
		const target = await requireVersion(profileId, contractId, sequence);

		// Already live: return as-is.
		if (target.state === CONTRACT_STATE.PUBLISHED) return { contract: target, idempotent: true, superseded: null };

		// Superseded versions are historical; they can never be brought back.
		if (target.state === CONTRACT_STATE.SUPERSEDED)
			throw new AppError(409, "CONTRACT_STATE_INVALID", "A superseded contract cannot be published again.", {
				contractId,
				sequence,
			});

		const publishedAt = now();

		// If an identical live version already exists for the same request, publishing
		// is a no-op and the draft is left untouched rather than superseding anything
		// with the same content.
		const current = await repository.findPublishedForRequest(profileId, target.requestId);
		if (current && contentEqual(current, target) && current.contractId === target.contractId) {
			return { contract: current, idempotent: true, superseded: null };
		}

		// Supersede the previously published version *for this request* before the new
		// version becomes live. The order matters: the database enforces at most one
		// PUBLISHED row per (profile, contract), so publishing first would collide with
		// the row being replaced. A DRAFT from an older sequence that was never
		// published does not need superseding, which is why the transition targets the
		// live row rather than the previous sequence.
		let superseded = null;
		if (current) superseded = await repository.markSuperseded(profileId, current.contractId, current.sequence, sequence, publishedAt);

		const published = await repository.markPublished(profileId, contractId, sequence, { publishedBy: actor, publishedAt });
		if (!published) {
			// The row left DRAFT between the read and the write. Restore the version that
			// was just superseded so a failed publish cannot silently unpublish a live
			// contract.
			if (current && superseded)
				await repository.restorePublished(profileId, current.contractId, current.sequence, publishedAt);
			throw new AppError(409, "CONTRACT_STATE_INVALID", "The contract could not be published because its state changed.");
		}

		return { contract: published, idempotent: false, superseded };
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------
	async function getVersion(ownerProfileId, contractId, sequence) {
		const profileId = assertProfileId(ownerProfileId);
		return requireVersion(profileId, contractId, sequence);
	}

	async function listVersions(ownerProfileId, contractId) {
		const profileId = assertProfileId(ownerProfileId);
		return repository.listVersions(profileId, contractId);
	}

	// The live contract for a request — the one a later phase will compare against.
	async function getCurrentForRequest(ownerProfileId, requestId) {
		const profileId = assertProfileId(ownerProfileId);
		if (!requestId) throw new AppError(400, "CONTRACT_INVALID", "A request identifier is required.");
		return repository.findPublishedForRequest(profileId, requestId);
	}

	async function listForRequest(ownerProfileId, requestId) {
		const profileId = assertProfileId(ownerProfileId);
		return repository.listForRequest(profileId, requestId);
	}

	async function listForProfile(ownerProfileId, options) {
		const profileId = assertProfileId(ownerProfileId);
		return repository.listForProfile(profileId, options);
	}

	// -----------------------------------------------------------------------
	// Inference (pure; never executes a request)
	// -----------------------------------------------------------------------
	async function createDraftFromResponse(ownerProfileId, input, inferred) {
		// The inference helper produced a candidate body; the normal create path
		// validates and stores it, so inferred and explicit contracts obey identical
		// limits.
		return createDraft(ownerProfileId, { ...input, provenance: "inferred", body: inferred.body });
	}

	async function requireVersion(profileId, contractId, sequence) {
		if (!contractId) throw new AppError(400, "CONTRACT_INVALID", "A contract identifier is required.");
		if (!Number.isInteger(sequence) || sequence < 1) throw new AppError(400, "CONTRACT_INVALID", "A contract version must be a positive integer.");
		const found = await repository.findVersion(profileId, contractId, sequence);
		if (!found) throw new AppError(404, "CONTRACT_NOT_FOUND", "The requested contract version does not exist.", { contractId, sequence });
		return found;
	}

	// Project a stored row back into the write-side input shape so update can reuse
	// the same schema and content builder as create.
	function projectToInput(contract) {
		return {
			collectionId: contract.collectionId ?? null,
			workspaceId: contract.workspaceId ?? null,
			requestId: contract.requestId,
			snapshotId: contract.snapshotId ?? null,
			snapshotFingerprint: contract.snapshotFingerprint ?? null,
			name: contract.content.name,
			description: contract.content.description ?? "",
			provenance: contract.content.provenance,
			body: contract.content.body,
		};
	}

	return {
		createDraft,
		updateDraft,
		discardDraft,
		publish,
		getVersion,
		listVersions,
		getCurrentForRequest,
		listForRequest,
		listForProfile,
		createDraftFromResponse,
		// Exposed so tests and later phases can assert the bounds without importing
		// the schema module directly.
		limits: CONTRACT_LIMITS,
	};
}

// Default instance, for consumers that do not need to inject a repository.
export const contractRegistryService = createContractRegistryService();
