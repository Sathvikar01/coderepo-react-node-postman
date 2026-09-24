import { AppError } from "../../shared/errors/app-error.js";
import { analyzeChange, analyzeChanges, analyzeWorkspaceDiff, buildGraph } from "./change-impact.service.js";

// Repository / snapshot adapter for change-impact analysis.
//
// The engine itself is pure. This adapter is the only place that reads persistence
// and the only seam later phases use. It offers two entry shapes:
//   * analyzeCurrent / analyzeCurrentMany  — load the live workspace for a profile
//   * analyzeSnapshotDiff                  — diff two supplied workspace snapshots
// The snapshot path takes plain workspace documents and has no dependency on any
// snapshot-storage feature internals.

function idOf(value) {
	return value === undefined || value === null ? null : String(value);
}

export function toWorkspaceCollection(document) {
	return {
		id: idOf(document._id ?? document.id),
		ownerProfileId: idOf(document.ownerProfileId),
		name: document.name ?? null,
		variables: document.variables ?? [],
		auth: document.auth ?? { mode: "none" },
		folders: document.folders ?? [],
		requests: document.requests ?? [],
	};
}

export function toWorkspaceEnvironment(document) {
	return {
		id: idOf(document._id ?? document.id),
		ownerProfileId: idOf(document.ownerProfileId),
		name: document.name ?? null,
		variables: document.variables ?? [],
	};
}

export function assertProfileScope(workspace, ownerProfileId) {
	if (!ownerProfileId) return workspace;
	const expected = idOf(ownerProfileId);
	for (const entity of [...(workspace.collections ?? []), ...(workspace.environments ?? [])]) {
		if (entity.ownerProfileId && entity.ownerProfileId !== expected)
			throw new AppError(403, "CHANGE_IMPACT_PROFILE_MISMATCH", "The workspace contains data owned by another profile.", {
				entityId: entity.id,
			});
	}
	return workspace;
}

export function createChangeImpactAdapter({ collectionRepository, environmentRepository, collectionSource, environmentSource } = {}) {
	const loadCollections =
		collectionSource ??
		(async (ownerProfileId) => {
			const summaries = await collectionRepository.list(ownerProfileId);
			const documents = [];
			for (const summary of summaries) {
				const document = await collectionRepository.findById(summary._id, ownerProfileId);
				if (document) documents.push(document);
			}
			return documents;
		});

	const loadEnvironments =
		environmentSource ??
		(async (ownerProfileId) => {
			const summaries = await environmentRepository.list(ownerProfileId);
			const documents = [];
			for (const summary of summaries) {
				const document = await environmentRepository.findById(summary._id, ownerProfileId);
				if (document) documents.push(document);
			}
			return documents;
		});

	async function loadWorkspace({ ownerProfileId, environmentId = null }) {
		if (!collectionSource && !collectionRepository)
			throw new AppError(500, "CHANGE_IMPACT_ADAPTER_UNCONFIGURED", "No collection source is configured.");
		if (!environmentSource && !environmentRepository)
			throw new AppError(500, "CHANGE_IMPACT_ADAPTER_UNCONFIGURED", "No environment source is configured.");
		const [collections, environments] = await Promise.all([loadCollections(ownerProfileId), loadEnvironments(ownerProfileId)]);
		return {
			ownerProfileId: idOf(ownerProfileId),
			environmentId,
			collections: collections.map(toWorkspaceCollection),
			environments: environments.map(toWorkspaceEnvironment),
		};
	}

	return {
		loadWorkspace,
		async analyzeCurrent({ ownerProfileId, environmentId = null, change, maxDepth }) {
			const workspace = assertProfileScope(await loadWorkspace({ ownerProfileId, environmentId }), ownerProfileId);
			return analyzeChange({ workspace, change, maxDepth });
		},
		async analyzeCurrentMany({ ownerProfileId, environmentId = null, changes, maxDepth }) {
			const workspace = assertProfileScope(await loadWorkspace({ ownerProfileId, environmentId }), ownerProfileId);
			return analyzeChanges({ workspace, changes, maxDepth });
		},
		analyzeSnapshotDiff({ before, after, changes, environmentId, maxDepth }) {
			return analyzeWorkspaceDiff({ before, after, changes, environmentId, maxDepth });
		},
		buildGraphFromWorkspace(workspace) {
			return buildGraph(workspace);
		},
	};
}
