// Phase 46B — Deterministic string ordering.
//
// One comparison helper used everywhere ordering matters, so canonical output does
// not depend on the platform's locale or ICU data. Kept in its own module (rather
// than shared/utils) because Phase 46B must not touch shared files, and the
// checkpoint feature must be self-contained.

export function compareStrings(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
