import { Router } from "express";
import {
	buildProof,
	exportProof,
	importProof,
	retrieveProof,
	verifyProof,
} from "./verification-proof.controller.js";

// Phase 47B — Verification Proof API routes.
//
// Mounted by `app.js` with `requireWorkspaceAuth` + `resolveProfileContext`, so
// every handler runs with a resolved `request.profileId`. There is no
// unauthenticated route here: a proof names a workspace's evidence, and a build
// input is caller-supplied identity, so both must be profile-scoped.
export const verificationProofRouter = Router();

verificationProofRouter.post("/", buildProof);
verificationProofRouter.post("/export", exportProof);
verificationProofRouter.post("/import", importProof);
verificationProofRouter.post("/verify", verifyProof);
verificationProofRouter.post("/retrieve", retrieveProof);
