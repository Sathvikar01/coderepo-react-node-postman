import { COMPATIBILITY_CODES, classForCode } from "./compatibility-schema.js";
import { BODY_REPRESENTATION, SUSPECT_PROPERTY_NAMES, observableTypeOf } from "./response-normalization.js";

// Phase 43A — Body structure comparison.
//
// Walks a Phase-42 contract body node tree against an observed body value and
// reports typed findings. The walk is pure and total: it never throws on
// adversarial observed data, and it never invents semantics the Phase-42
// vocabulary does not express.
//
// The governing rule is asymmetry. The contract is authoritative, so:
//
//   * the engine never loosens a contract rule to accept an observation, and
//   * the engine never tightens a contract rule because of one sample.
//
// The second rule is why extra observed properties are NON_BREAKING (Phase 42 has
// no closed-object vocabulary), why an absent optional property produces no
// breaking finding, and why an empty array whose item shape cannot be observed
// yields UNKNOWN rather than a guess in either direction.

const TYPE_LABELS = Object.freeze({
	string: "string",
	number: "number",
	boolean: "boolean",
	null: "null",
	object: "object",
	array: "array",
});

function finding(code, { path, contractPath = null, parentPath = null, expected, actual }) {
	return {
		code,
		class: classForCode(code),
		path,
		contractPath,
		parentPath,
		expected,
		actual,
	};
}

function typeLabel(value) {
	const type = observableTypeOf(value);
	return type === null ? "unsupported" : TYPE_LABELS[type] ?? type;
}

// A property name that would subvert a deep-merging consumer. Phase 42A refuses
// these in contracts; observed data is refused as unobservable rather than walked.
function isSuspectName(name) {
	return SUSPECT_PROPERTY_NAMES.has(String(name).toLowerCase());
}

// Format a descendant path. Object keys use dot notation; array indices use
// bracket notation, so a path is always unambiguous and sortable.
function childPath(parent, key) {
	return `${parent}.${key}`;
}

function itemPath(parent, index) {
	return `${parent}[${index}]`;
}

// Compare an enum. Only reached when the contract node explicitly declares one.
function compareEnum(node, { path, contractPath, parentPath, value }) {
	const allowed = node.enum ?? [];
	if (allowed.length === 0) return [];
	const matched = allowed.some((candidate) => Object.is(candidate, value) || (typeof candidate === typeof value && candidate === value));
	if (matched)
		return [
			finding(COMPATIBILITY_CODES.ENUM_VALUE_ALLOWED, {
				path,
				contractPath,
				parentPath,
				expected: [...allowed],
				actual: value === undefined ? null : value,
			}),
		];
	return [
		finding(COMPATIBILITY_CODES.ENUM_VALUE_NOT_ALLOWED, {
			path,
			contractPath,
			parentPath,
			expected: [...allowed],
			// The observed value is echoed only when it is a scalar the vocabulary can
			// express; a structural value is summarized by its type so a huge body cannot
			// be smuggled into a finding.
			actual: isScalar(value) ? value : typeLabel(value),
		}),
	];
}

function isScalar(value) {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// Compare a contract type node against an observed value.
//
// Returns a list of findings. `contractPath` locates the node in the contract;
// `parentPath` is the enclosing observed container, which gives a consumer enough
// context to place a finding without re-walking.
export function compareNode(node, value, context) {
	if (!node || typeof node !== "object") return [];
	const { path, contractPath, parentPath = null } = context;

	const observedType = observableTypeOf(value);

	// A value the contract vocabulary cannot express at all. This is not a type
	// change; it is an unusable sample, so it is reported as UNKNOWN.
	if (observedType === null) {
		return [
			finding(COMPATIBILITY_CODES.UNSUPPORTED_BODY_REPRESENTATION, {
				path,
				contractPath,
				parentPath,
				expected: node.type ?? "unknown",
				actual: "unsupported",
			}),
		];
	}

	// Node type mismatch. `null` is a distinct type, so `object -> null` is a change.
	// An enum may narrow a scalar contract to a specific value set, but it never
	// changes the declared type, so the type check runs first.
	if (observedType !== node.type) {
		// A node may legitimately declare `null` and the observed value be null; that
		// is the matching branch. Everything else that differs is a type change.
		return [
			finding(COMPATIBILITY_CODES.BODY_TYPE_CHANGED, {
				path,
				contractPath,
				parentPath,
				expected: node.type,
				actual: observedType,
			}),
		];
	}

	// The node type is satisfied. A scalar node records the match and, if it declares
	// an enum, additionally evaluates the enum.
	if (!["object", "array"].includes(node.type)) {
		const findings = [
			finding(COMPATIBILITY_CODES.PROPERTY_TYPE_MATCHES, {
				path,
				contractPath,
				parentPath,
				expected: node.type,
				actual: observedType,
			}),
		];
		if (Array.isArray(node.enum) && node.enum.length > 0) findings.push(...compareEnum(node, { path, contractPath, parentPath, value }));
		return findings;
	}

	if (node.type === "object") return compareObject(node, value, { path, contractPath, parentPath });
	return compareArray(node, value, { path, contractPath, parentPath });
}

// Compare an object node.
function compareObject(node, value, { path, contractPath, parentPath }) {
	const findings = [];
	const properties = node.properties ?? {};
	const requiredProperties = Array.isArray(node.requiredProperties) ? node.requiredProperties : [];

	// A contract may describe an object with no declared properties. Such a node
	// asserts only "this is an object"; extra observed keys are harmless.
	const declaredNames = Object.keys(properties);
	const declaredLower = new Map(declaredNames.map((name) => [name.toLowerCase(), name]));

	for (const name of [...declaredNames].sort()) {
		const propertyNode = properties[name];
		const childContractPath = `${contractPath}.properties.${name}`;
		const observedPath = childPath(path, name);
		const isRequired = requiredProperties.includes(name);
		const hasOwn = Object.prototype.hasOwnProperty.call(value, name) && !isSuspectName(name);
		const observed = hasOwn ? value[name] : undefined;

		if (!hasOwn) {
			if (isRequired) {
				findings.push(
					finding(COMPATIBILITY_CODES.REQUIRED_PROPERTY_MISSING, {
						path: observedPath,
						contractPath: childContractPath,
						parentPath: path,
						expected: propertyNode.type ?? "present",
						actual: "absent",
					}),
				);
				continue;
			}
			// An optional property's absence is compatible and is recorded explicitly so
			// the report distinguishes "checked and absent" from "not checked".
			findings.push(
				finding(COMPATIBILITY_CODES.OPTIONAL_PROPERTY_ABSENT, {
					path: observedPath,
					contractPath: childContractPath,
					parentPath: path,
					expected: propertyNode.type ?? "optional",
					actual: "absent",
				}),
			);
			continue;
		}

		if (isRequired) {
			// Required and present. The presence finding is recorded before the type walk
			// so a required property that is present but mistyped yields both signals.
			findings.push(
				finding(COMPATIBILITY_CODES.REQUIRED_PROPERTY_PRESENT, {
					path: observedPath,
					contractPath: childContractPath,
					parentPath: path,
					expected: propertyNode.type ?? "present",
					actual: "present",
				}),
			);
		}

		findings.push(...compareNode(propertyNode, observed, { path: observedPath, contractPath: childContractPath, parentPath: path }));
	}

	// Extra observed properties. Phase 42 has no closed-object vocabulary, so an
	// unexpected key is NON_BREAKING — never BREAKING, and never silently ignored.
	const observedKeys = Object.keys(value).filter((key) => !isSuspectName(key));
	for (const key of observedKeys.sort()) {
		if (declaredLower.has(key.toLowerCase())) continue;
		findings.push(
			finding(COMPATIBILITY_CODES.ADDITIONAL_PROPERTY_PRESENT, {
				path: childPath(path, key),
				contractPath: null,
				parentPath: path,
				expected: "undeclared",
				actual: typeLabel(value[key]),
			}),
		);
	}

	return findings;
}

// Compare an array node.
//
// Phase 42 describes an array by a single element shape, never a union of shapes.
// The engine therefore validates every observed element against that one shape.
// An empty observed array cannot exercise the item shape: if the contract declares
// one, the outcome is UNKNOWN rather than a pass.
function compareArray(node, value, { path, contractPath, parentPath }) {
	const findings = [];
	const itemNode = node.items ?? null;

	if (!itemNode) {
		// The contract asserts only "this is an array" and describes no element shape.
		// Nothing more can be checked.
		findings.push(
			finding(COMPATIBILITY_CODES.BODY_TYPE_MATCHES, {
				path,
				contractPath,
				parentPath,
				expected: "array",
				actual: "array",
			}),
		);
		return findings;
	}

	if (value.length === 0) {
		// Uncertainty, not compatibility. The item shape the contract asserts was never
		// observable in this sample.
		findings.push(
			finding(COMPATIBILITY_CODES.ARRAY_ITEM_SHAPE_UNOBSERVABLE, {
				path: `${path}[0]`,
				contractPath: `${contractPath}.items`,
				parentPath: path,
				expected: itemNode.type ?? "unknown",
				actual: "empty",
			}),
		);
		return findings;
	}

	const itemContractPath = `${contractPath}.items`;
	for (let index = 0; index < value.length; index += 1) {
		const observedItem = value[index];
		const observedPath = itemPath(path, index);
		// Item type is checked here so an item-level type change is reported with the
		// array-specific code, which consumers read to tell "the array element type
		// changed" from "a nested property changed".
		const observedType = observableTypeOf(observedItem);
		const expectedType = itemNode.type ?? null;
		if (observedType === null) {
			findings.push(
				finding(COMPATIBILITY_CODES.UNSUPPORTED_BODY_REPRESENTATION, {
					path: observedPath,
					contractPath: itemContractPath,
					parentPath: path,
					expected: expectedType ?? "unknown",
					actual: "unsupported",
				}),
			);
			continue;
		}
		if (expectedType && observedType !== expectedType) {
			findings.push(
				finding(COMPATIBILITY_CODES.ARRAY_ITEM_TYPE_CHANGED, {
					path: observedPath,
					contractPath: itemContractPath,
					parentPath: path,
					expected: expectedType,
					actual: observedType,
				}),
			);
			continue;
		}
		// The item matches at this level; descend for objects, arrays, and enums. The
		// descending walk re-derives the match findings, so no duplicate is recorded.
		if (["object", "array"].includes(observedType) || Array.isArray(itemNode.enum) || isScalar(observedItem)) {
			const nested = compareNode(itemNode, observedItem, { path: observedPath, contractPath: itemContractPath, parentPath: path });
			// The type-level match is already implied by the item loop; keep nested
			// findings that carry new information (structure, enums, containers).
			for (const entry of nested) {
				if (entry.code === COMPATIBILITY_CODES.PROPERTY_TYPE_MATCHES && !["object", "array"].includes(observedType)) continue;
				findings.push(entry);
			}
		}
	}

	if (findings.length === 0) {
		findings.push(
			finding(COMPATIBILITY_CODES.BODY_TYPE_MATCHES, {
				path,
				contractPath,
				parentPath,
				expected: "array",
				actual: "array",
			}),
		);
	}

	return findings;
}

// Compare a whole contract body node against a normalized observed body.
//
// `bodyRepresentation` is consulted so a body the engine could not interpret is
// reported as UNKNOWN. Guessing a type for a malformed payload would turn a
// caller-side failure into a confident compatibility verdict.
export function compareBody({ contractBody, observed }) {
	if (!contractBody) return [];

	// "No body expected" and "no body supplied" agree.
	const node = contractBody.body ?? null;
	const representation = observed.bodyRepresentation;

	if (representation === BODY_REPRESENTATION.MALFORMED) {
		return [
			finding(COMPATIBILITY_CODES.UNSUPPORTED_BODY_REPRESENTATION, {
				path: "$",
				contractPath: "$.body",
				parentPath: null,
				expected: node?.type ?? contractBody.bodyType ?? "none",
				actual: "malformed",
			}),
		];
	}

	if (!node) {
		// The contract declares no body shape. If the contract also declares no body
		// type, there is nothing to assert and nothing to report.
		if (!contractBody.bodyType) return [];
		// A declared body type with no shape can still be checked against the root.
		const value = representation === BODY_REPRESENTATION.ABSENT ? undefined : observed.body.value;
		if (representation === BODY_REPRESENTATION.ABSENT) {
			return [
				finding(COMPATIBILITY_CODES.BODY_TYPE_CHANGED, {
					path: "$",
					contractPath: "$.body",
					parentPath: null,
					expected: contractBody.bodyType,
					actual: "absent",
				}),
			];
		}
		if (observableTypeOf(value) === contractBody.bodyType) return [];
		return [
			finding(COMPATIBILITY_CODES.BODY_TYPE_CHANGED, {
				path: "$",
				contractPath: "$.body",
				parentPath: null,
				expected: contractBody.bodyType,
				actual: observableTypeOf(value) ?? "unsupported",
			}),
		];
	}

	// The contract declares a body shape, but no body was supplied at all. That is a
	// missing required structure, reported against the root.
	if (representation === BODY_REPRESENTATION.ABSENT) {
		return [
			finding(COMPATIBILITY_CODES.BODY_TYPE_CHANGED, {
				path: "$",
				contractPath: "$.body",
				parentPath: null,
				expected: node.type,
				actual: "absent",
			}),
		];
	}

	return compareNode(node, observed.body.value, { path: "$", contractPath: "$.body", parentPath: null });
}
