import {
	classifyAddedBinding,
	classifyChangedBinding,
	classifyMissingBinding,
	classifySelectionChange,
	classifyUnresolvedBinding,
} from "./drift-severity.js";

// Phase 40A — drift comparator.
//
// Compares two canonical effective environment states and emits one entry per
// meaningful difference. The comparison is effective-first: a variable that is
// removed from an environment but still provided by the shared collection is
// not drift, because the effective configuration did not change. That is what
// makes "identical effective configuration produces zero drift" true.
//
// Duplicate drift is deduplicated by (category, path); affected reference ids
// are merged and sorted. Output order is stable: sorted by path, then category.

function bindingEqual(left, right) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "secretRef") return left.alias === right.alias;
	return left.value === right.value;
}

// Public, secret-free projection of a binding. A secretRef carries only its
// alias, never a resolved value.
function presentBinding(binding) {
	if (!binding) return null;
	if (binding.kind === "secretRef") return { kind: "secretRef", alias: binding.alias };
	return { kind: "plain", value: binding.value };
}

function affectedReferenceIds(state, key) {
	const ids = new Set();
	for (const reference of state.references) {
		if (reference.key === key && reference.referenceId) ids.add(String(reference.referenceId));
	}
	return [...ids].sort();
}

function pushEntry(entries, { classification, path, sourceState, targetState, affected }) {
	entries.push({
		category: classification.category,
		path,
		sourceState,
		targetState,
		affectedReferenceIds: affected,
		severity: classification.severity,
		status: classification.status,
	});
}

// Deduplicates by (category, path), merging affected reference ids. A later
// duplicate can only add references, never change the classification.
function dedupe(entries) {
	const byKey = new Map();
	for (const entry of entries) {
		const key = `${entry.category}\u0000${entry.path}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, entry);
			continue;
		}
		const merged = [...new Set([...existing.affectedReferenceIds, ...entry.affectedReferenceIds])].sort();
		existing.affectedReferenceIds = merged;
	}
	return [...byKey.values()];
}

export function compareEnvironmentStates(source, target) {
	const entries = [];
	const referencedKeys = new Set([...source.referencedKeys, ...target.referencedKeys]);
	const reportedKeys = new Set();

	// Environment identity: the selection itself changed.
	if (source.environment.id !== target.environment.id || source.environment.name !== target.environment.name) {
		pushEntry(entries, {
			classification: classifySelectionChange(),
			path: "environment.selection",
			sourceState: { id: source.environment.id, name: source.environment.name },
			targetState: { id: target.environment.id, name: target.environment.name },
			affected: [],
		});
	}

	const keys = new Set([
		...source.declared.keys(),
		...target.declared.keys(),
		...source.effective.keys(),
		...target.effective.keys(),
	]);

	for (const key of [...keys].sort()) {
		const sourceEffective = source.effective.get(key);
		const targetEffective = target.effective.get(key);
		const sourceDeclared = source.declared.get(key);
		const targetDeclared = target.declared.get(key);
		const referenced = referencedKeys.has(key);
		const affected = affectedReferenceIds(source, key);
		reportedKeys.add(key);

		if (sourceEffective && targetEffective) {
			if (!bindingEqual(sourceEffective, targetEffective)) {
				pushEntry(entries, {
					classification: classifyChangedBinding({
						key,
						source: sourceEffective,
						target: targetEffective,
						roles: source.roles,
						referenced,
					}),
					path: `variables.${key}`,
					sourceState: presentBinding(sourceEffective),
					targetState: presentBinding(targetEffective),
					affected,
				});
			}
			continue;
		}

		if (sourceEffective && !targetEffective) {
			// Declared in the target but disabled, or removed while referenced:
			// a required reference can no longer bind. A referenced variable that
			// is simply gone is a missing required reference (high); a disabled
			// one is an unresolved reference (unknown).
			if (referenced && targetDeclared) {
				pushEntry(entries, {
					classification: classifyUnresolvedBinding(),
					path: `references.${key}`,
					sourceState: { resolved: true },
					targetState: { resolved: false },
					affected,
				});
			} else {
				pushEntry(entries, {
					classification: classifyMissingBinding({ referenced }),
					path: `variables.${key}`,
					sourceState: presentBinding(sourceEffective),
					targetState: null,
					affected,
				});
			}
			continue;
		}

		if (!sourceEffective && targetEffective) {
			if (referenced && sourceDeclared) {
				pushEntry(entries, {
					classification: classifyUnresolvedBinding(),
					path: `references.${key}`,
					sourceState: { resolved: false },
					targetState: { resolved: true },
					affected,
				});
			} else {
				pushEntry(entries, {
					classification: classifyAddedBinding({ referenced }),
					path: `variables.${key}`,
					sourceState: null,
					targetState: presentBinding(targetEffective),
					affected,
				});
			}
			continue;
		}

		// Neither side resolves the key. A disabled variable that exists on only
		// one side is still configuration drift, but it has no effective value.
		if (sourceDeclared && !targetDeclared) {
			pushEntry(entries, {
				classification: classifyMissingBinding({ referenced }),
				path: `variables.${key}`,
				sourceState: presentBinding(sourceDeclared),
				targetState: null,
				affected,
			});
		} else if (!sourceDeclared && targetDeclared) {
			pushEntry(entries, {
				classification: classifyAddedBinding({ referenced }),
				path: `variables.${key}`,
				sourceState: null,
				targetState: presentBinding(targetDeclared),
				affected,
			});
		}
	}

	// Safety net for references whose resolution differs without a reported
	// variable difference. With a shared collection this is normally empty; it
	// keeps the comparator correct if a future phase supplies per-side scopes.
	for (const key of [...referencedKeys].sort()) {
		if (reportedKeys.has(key)) continue;
		const sourceResolved = source.effective.has(key);
		const targetResolved = target.effective.has(key);
		if (sourceResolved === targetResolved) continue;
		pushEntry(entries, {
			classification: classifyUnresolvedBinding(),
			path: `references.${key}`,
			sourceState: { resolved: sourceResolved },
			targetState: { resolved: targetResolved },
			affected: affectedReferenceIds(source, key),
		});
	}

	const deduped = dedupe(entries);
	deduped.sort((left, right) => {
		if (left.path !== right.path) return left.path < right.path ? -1 : 1;
		if (left.category !== right.category) return left.category < right.category ? -1 : 1;
		return 0;
	});
	return deduped;
}
