import { ContractCounter, ContractVersion } from "./contract.model.js";

// Phase 42A — Contract repository.
//
// Thin and profile-scoped: every read and write is constrained by
// ownerProfileId, so a contract can never be observed or mutated across profiles.
// No business rules live here; the service owns lifecycle decisions.

const SUMMARY =
	"contractId sequence state requestId collectionId snapshotId snapshotFingerprint contentFingerprint content.name content.provenance content.body.status content.body.statuses createdAt updatedAt publishedAt supersededBySequence supersededAt";

export const contractRepository = {
	// Atomically reserve the next version number for a (profile, contract) pair.
	//
	// MongoDB rejects an update that increments and sets the same field, so the fast
	// path is a pure `$inc`; when the counter does not exist yet it is created with
	// `nextSequence: 1` and unique-index races are retried against the fast path. The
	// value after `$inc` is exactly the version number the caller may use, including
	// the very first allocation.
	async allocateSequence(ownerProfileId, contractId) {
		const incremented = await ContractCounter.findOneAndUpdate(
			{ ownerProfileId, contractId },
			{ $inc: { nextSequence: 1 } },
			{ new: true },
		).lean();
		if (incremented) return incremented.nextSequence;

		try {
			const created = await ContractCounter.create({ ownerProfileId, contractId, nextSequence: 1 });
			return created.nextSequence;
		} catch (error) {
			// Another caller created the counter first; retry the increment path once.
			if (error?.code === 11000) {
				const retried = await ContractCounter.findOneAndUpdate(
					{ ownerProfileId, contractId },
					{ $inc: { nextSequence: 1 } },
					{ new: true },
				).lean();
				if (retried) return retried.nextSequence;
			}
			throw error;
		}
	},

	insertVersion: (document) => ContractVersion.create(document),

	findVersion: (ownerProfileId, contractId, sequence) =>
		ContractVersion.findOne({ ownerProfileId, contractId, sequence }).lean(),

	findById: (ownerProfileId, id) => ContractVersion.findOne({ _id: id, ownerProfileId }).lean(),

	// All versions of one contract, oldest first. History is never deleted, so this
	// is a complete audit trail.
	listVersions: (ownerProfileId, contractId) =>
		ContractVersion.find({ ownerProfileId, contractId }).sort({ sequence: 1 }).select(SUMMARY).lean(),

	// The current live version for a request, if any.
	findPublishedForRequest: (ownerProfileId, requestId) =>
		ContractVersion.findOne({ ownerProfileId, requestId, state: "PUBLISHED" }).lean(),

	// The newest published row for a (profile, contract) pair, whatever request it
	// is bound to.
	findPublishedForContract: (ownerProfileId, contractId) =>
		ContractVersion.findOne({ ownerProfileId, contractId, state: "PUBLISHED" }).lean(),

	listForRequest: (ownerProfileId, requestId) =>
		ContractVersion.find({ ownerProfileId, requestId }).sort({ contractId: 1, sequence: 1 }).select(SUMMARY).lean(),

	listForProfile: (ownerProfileId, { state } = {}) =>
		ContractVersion.find({ ownerProfileId, ...(state ? { state } : {}) })
			.sort({ requestId: 1, contractId: 1, sequence: 1 })
			.select(SUMMARY)
			.lean(),

	// DRAFT -> PUBLISHED. Guarded by the current state so a version cannot be
	// published twice or resurrected after supersession.
	markPublished: (ownerProfileId, contractId, sequence, { publishedBy, publishedAt }) =>
		ContractVersion.findOneAndUpdate(
			{ ownerProfileId, contractId, sequence, state: "DRAFT" },
			{ $set: { state: "PUBLISHED", publishedBy: publishedBy ?? null, publishedAt, supersededBySequence: null, supersededAt: null } },
			{ new: true },
		).lean(),

	// PUBLISHED -> SUPERSEDED for the previous live version when a newer one lands.
	markSuperseded: (ownerProfileId, contractId, sequence, supersededBySequence, supersededAt) =>
		ContractVersion.findOneAndUpdate(
			{ ownerProfileId, contractId, sequence, state: "PUBLISHED" },
			{ $set: { state: "SUPERSEDED", supersededBySequence, supersededAt } },
			{ new: true },
		).lean(),

	// Compensating action for a publish that superseded the previous live version and
	// then failed to promote its own row. Returning the previous version to PUBLISHED
	// keeps the invariant “a request with a live contract still has one”.
	restorePublished: (ownerProfileId, contractId, sequence) =>
		ContractVersion.findOneAndUpdate(
			{ ownerProfileId, contractId, sequence, state: "SUPERSEDED" },
			{ $set: { state: "PUBLISHED", supersededBySequence: null, supersededAt: null } },
			{ new: true },
		).lean(),

	// Replace the content of an existing DRAFT row. Published rows are excluded by
	// the state filter, which is what makes published contracts immutable.
	replaceDraftContent: (ownerProfileId, contractId, sequence, update) =>
		ContractVersion.findOneAndUpdate(
			{ ownerProfileId, contractId, sequence, state: "DRAFT" },
			{ $set: update },
			{ new: true },
		).lean(),

	// Remove a DRAFT row so it can be discarded without leaving history behind.
	// Only drafts are deletable; published and superseded rows are permanent.
	deleteDraft: (ownerProfileId, contractId, sequence) =>
		ContractVersion.findOneAndDelete({ ownerProfileId, contractId, sequence, state: "DRAFT" }).lean(),

	countForProfile: (ownerProfileId) => ContractVersion.countDocuments({ ownerProfileId }),
};
