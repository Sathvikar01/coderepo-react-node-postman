// Public API for the git-native TracerProjectV1 workflow.
//
// Phase 16 owns the portable project model (projectFromDomain / projectToDomain
// / serializeProject / projectFingerprint). This feature layers a deterministic
// multi-file layout on top of that model so a project can be versioned, diffed,
// reviewed, and re-imported through Git without making Git the runtime database.
//
// The boundary is always the validated TracerProjectV1:
//
//   domain --projectFromDomain--> portable --projectToFiles--> files
//   files  --filesToProject--> portable --projectToDomain--> domain
//
// "Import back into Tracer" is the files -> portable -> domain path: the result
// is the workspace aggregate (collections / environments / examples) ready to
// apply. Nothing here mutates execution state, resolves secrets, or runs Git.

export { projectFromDomain } from "../projects/project-export.js";
export { projectToDomain } from "../projects/project-import.js";
export { projectFingerprint, serializeProject, parseProject } from "../projects/project-serialize.js";

export { projectToFiles, filesToProject, MANIFEST } from "./project-layout.js";
export { diffText, diffProjectFiles, diffChangeCount } from "./project-diff.js";
export { readProjectDir, writeProjectDir } from "./project-fs.js";
export {
	LAYOUT_VERSION,
	stableStringify,
	sha256Hex,
	slugSegment,
	fileStem,
	assertSafeRelPath,
	hasConflictMarkers,
} from "./project-text.js";

import { projectFromDomain } from "../projects/project-export.js";
import { projectToDomain } from "../projects/project-import.js";
import { projectFingerprint } from "../projects/project-serialize.js";
import { filesToProject, projectToFiles } from "./project-layout.js";
import { sha256Hex } from "./project-text.js";

// Domain -> git-native files. Accepts the repository/domain documents and
// returns the deterministic Map of relative paths to file text.
export function exportDomainToFiles(domain) {
	return projectToFiles(projectFromDomain(domain));
}

// Git-native files -> workspace domain (validated, ready to apply).
export function importFilesToDomain(files) {
	return projectToDomain(filesToProject(files));
}

// Validate a set of project files without applying anything. Returns the
// reconstructed portable project and its canonical fingerprint on success and
// throws a fail-closed AppError on malformed / version-incompatible / unknown /
// conflicting content.
export function validateProjectFiles(files) {
	const project = filesToProject(files);
	return { project, fingerprint: projectFingerprint(project), name: project.name ?? null };
}

// Per-file content hashes for drift / integrity visibility. Deterministic and
// keyed by relative path. Advisory only: external edits legitimately change
// hashes, so import never gates on these.
export function hashProjectFiles(files) {
	const map = files instanceof Map ? files : new Map(Object.entries(files ?? {}));
	const hashes = new Map();
	for (const rel of [...map.keys()].sort()) hashes.set(rel, sha256Hex(map.get(rel)));
	return hashes;
}
