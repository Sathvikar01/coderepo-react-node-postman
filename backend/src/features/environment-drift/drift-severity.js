// Phase 40A — deterministic severity classifier.
//
// Severity comes only from the explicit rules below. There is no scoring, no
// heuristic weighting, and no language model. "unknown" means the impact cannot
// be established from configuration alone; it is never a pass.
//
// Rules:
//   * missing referenced variable  -> high   (a required reference cannot bind)
//   * auth reference/config change -> high
//   * base URL / host change       -> high
//   * API version change           -> high
//   * secret reference change      -> high
//   * header config change         -> medium
//   * changed referenced value     -> medium
//   * added referenced variable    -> medium
//   * changed unused value         -> low
//   * added unused variable        -> low
//   * missing unused variable      -> low
//   * environment selection change -> low
//   * unresolved/dynamic reference -> unknown

function normalizedKey(key) {
	return String(key ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

// A version variable is named for a version, e.g. api_version, apiVersion, ver.
export function isVersionKey(key) {
	const name = normalizedKey(key);
	return name.endsWith("version") || name === "ver" || name === "apiver" || name === "schemaversion";
}

// A base URL/host variable is named for the origin of the target. Version names
// are excluded so `api_version` is never misread as a URL.
export function isBaseUrlKey(key) {
	const name = normalizedKey(key);
	if (isVersionKey(key)) return false;
	if (name.endsWith("url") || name.endsWith("host") || name.endsWith("origin") || name.endsWith("endpoint")) return true;
	return ["server", "apiserver", "apiroot", "baseorigin", "baseendpoint"].includes(name);
}

// Classifies a change where both sides resolve the same key to different
// bindings. `referenced` is true when the workspace uses the key anywhere.
export function classifyChangedBinding({ key, source, target, roles, referenced }) {
	// A secret reference is secret-safe by construction: only the alias is
	// compared, so any secret change is reported without a value.
	if (source.kind === "secretRef" || target.kind === "secretRef") {
		return { category: "SECRET_REFERENCE_CHANGED", severity: "high", status: "confirmed" };
	}
	if (roles.auth.has(key)) return { category: "AUTH_CONFIG_CHANGED", severity: "high", status: "confirmed" };
	if (isVersionKey(key)) return { category: "VERSION_CHANGED", severity: "high", status: "confirmed" };
	if (isBaseUrlKey(key)) return { category: "BASE_URL_CHANGED", severity: "high", status: "confirmed" };
	if (roles.header.has(key)) return { category: "HEADER_CONFIG_CHANGED", severity: "medium", status: "confirmed" };
	return { category: "VARIABLE_CHANGED", severity: referenced ? "medium" : "low", status: "confirmed" };
}

// Severity for a variable that only exists on one side.
export function classifyAddedBinding({ referenced }) {
	return { category: "VARIABLE_ADDED", severity: referenced ? "medium" : "low", status: "confirmed" };
}

export function classifyMissingBinding({ referenced }) {
	return { category: "VARIABLE_MISSING", severity: referenced ? "high" : "low", status: "confirmed" };
}

// A reference that cannot bind deterministically. The impact is unknown, so the
// entry is reported as unknown rather than guessed.
export function classifyUnresolvedBinding() {
	return { category: "UNRESOLVED_REFERENCE", severity: "unknown", status: "unknown" };
}

export function classifySelectionChange() {
	return { category: "ENVIRONMENT_SELECTION_CHANGED", severity: "low", status: "confirmed" };
}
