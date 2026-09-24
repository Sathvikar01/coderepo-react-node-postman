import { Router } from "express";
import { explainExecution, explainExecutionWithProof } from "./why-inspector.controller.js";

// Phase 49B — "Why?" Inspector routes.
//
// Mounted by `app.js` with `requireWorkspaceAuth` + `resolveProfileContext`, so
// every handler runs with a resolved `request.profileId`. There is no
// unauthenticated route: an explanation names a workspace's execution evidence,
// so it must be profile-scoped.
//
// The routes are intentionally read-only. An explanation is derived from evidence
// that already exists; it is never persisted, so it can never drift from the
// execution it describes. `POST` carries a caller-supplied Phase 47 proof
// artifact for this read and stores nothing.
export const whyInspectorRouter = Router();

whyInspectorRouter.get("/executions/:executionId", explainExecution);
whyInspectorRouter.post("/executions/:executionId", explainExecutionWithProof);
