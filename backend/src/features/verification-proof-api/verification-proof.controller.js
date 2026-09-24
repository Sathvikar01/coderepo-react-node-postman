import { z } from "zod";
import { LIMITS, utf8Bytes } from "../../shared/utils/limits.js";
import { PROOF_LIMITS, PROOF_STATE_VALUES, proofSnapshotIdentitySchema, proofTargetEnvironmentSchema } from "../verification-proof/index.js";
import {
	PROOF_ARTIFACT_KIND,
	PROOF_ARTIFACT_MAX_BYTES,
	PROOF_ARTIFACT_SCHEMA_VERSION,
} from "./proof-artifact.js";
import { verificationProofApiService } from "./verification-proof.service.js";

// Phase 47B — Verification Proof API controller.
//
// Every route is authenticated and profile-scoped by the app-level middleware.
// The controller only owns transport concerns: bounded strict schemas, status
// codes, and delegating to the service. It never builds a proof itself — the
// service calls the Phase 47A builder, so a proof can never be assembled here.

const MAX_ARTIFACT_BYTES = PROOF_ARTIFACT_MAX_BYTES;

// A bounded JSON text field. The byte ceiling is enforced on the UTF-8 length, not
// on the character count, so a multi-byte payload cannot slip past the limit.
// This schema owns the *transport* ceiling only. The artifact parser owns the
// tighter artifact ceiling and reports it with the documented 413 code and byte
// accounting, so the two limits never disagree about which error a caller sees.
const artifactTextSchema = z
	.string()
	.min(1)
	.refine((value) => utf8Bytes(value) <= LIMITS.jsonBodyProofArtifact, {
		message: `A proof import body is limited to ${LIMITS.jsonBodyProofArtifact} bytes.`,
	});

const currentSchema = z
	.object({
		snapshot: proofSnapshotIdentitySchema.optional(),
		targetEnvironment: proofTargetEnvironmentSchema.optional(),
		verificationState: z.enum(PROOF_STATE_VALUES).optional(),
		verification: z.unknown().optional(),
		impact: z.unknown().optional(),
		drift: z.unknown().optional(),
		contracts: z.unknown().optional(),
	})
	.strict();

const proofIdSchema = z.string().min(1).max(PROOF_LIMITS.maxIdentifierBytes);

// Build. The body IS the Phase 47A build input; the builder is the single source
// of truth for its shape, so this schema deliberately does not duplicate it.
const buildSchema = z.object({ input: z.record(z.string(), z.unknown()) }).strict();

const exportSchema = z
	.object({
		proof: z.record(z.string(), z.unknown()).optional(),
		input: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if ((value.proof === undefined) === (value.input === undefined)) {
			context.addIssue({
				code: "custom",
				message: "Provide exactly one of `proof` (an existing envelope) or `input` (a Phase 47A build input).",
			});
		}
	});

const importSchema = z.object({ text: artifactTextSchema }).strict();
const verifySchema = z
	.object({
		proof: z.record(z.string(), z.unknown()).optional(),
		text: artifactTextSchema.optional(),
		current: currentSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if ((value.proof === undefined) === (value.text === undefined)) {
			context.addIssue({ code: "custom", message: "Provide exactly one of `proof` or `text`." });
		}
	});

const retrieveSchema = z
	.object({
		// `proofId` is the wire name; `expectedProofId` is accepted as an alias so the
		// service's own vocabulary is usable directly. Both mean "the identity I expect".
		proofId: proofIdSchema.optional(),
		expectedProofId: proofIdSchema.optional(),
		text: artifactTextSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.proofId === undefined && value.expectedProofId === undefined && value.text === undefined) {
			context.addIssue({ code: "custom", message: "Provide a `proofId` and/or the `text` of the proof artifact." });
		}
	});

export const parseProofBuildRequest = (value) => buildSchema.parse(value);
export const parseProofExportRequest = (value) => exportSchema.parse(value);
export const parseProofImportRequest = (value) => importSchema.parse(value);
export const parseProofVerifyRequest = (value) => verifySchema.parse(value);
export const parseProofRetrieveRequest = (value) => retrieveSchema.parse(value);

export async function buildProof(request, response, next) {
	try {
		const { input } = parseProofBuildRequest(request.body);
		response.status(201).json({ data: verificationProofApiService.build(request.profileId, input) });
	} catch (error) {
		next(error);
	}
}

export async function exportProof(request, response, next) {
	try {
		const payload = parseProofExportRequest(request.body);
		response.json({ data: verificationProofApiService.exportProof(request.profileId, payload) });
	} catch (error) {
		next(error);
	}
}

export async function importProof(request, response, next) {
	try {
		const { text } = parseProofImportRequest(request.body);
		response.json({ data: verificationProofApiService.importProof(request.profileId, text) });
	} catch (error) {
		next(error);
	}
}

export async function verifyProof(request, response, next) {
	try {
		const payload = parseProofVerifyRequest(request.body);
		response.json({ data: verificationProofApiService.verify(request.profileId, payload) });
	} catch (error) {
		next(error);
	}
}

export async function retrieveProof(request, response, next) {
	try {
		const payload = parseProofRetrieveRequest(request.body);
		response.json({ data: verificationProofApiService.retrieve(request.profileId, payload) });
	} catch (error) {
		next(error);
	}
}

export const PROOF_API_ARTIFACT_META = Object.freeze({
	kind: PROOF_ARTIFACT_KIND,
	schemaVersion: PROOF_ARTIFACT_SCHEMA_VERSION,
	maxBytes: MAX_ARTIFACT_BYTES,
});
