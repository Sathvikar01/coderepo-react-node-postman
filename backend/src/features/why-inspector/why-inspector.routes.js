import { Router } from "express";
import { explainExecution } from "./why-inspector.controller.js";

// Phase 49 — "Why?" Inspector routes.
//
// Mounted by `app.js` with `requireWorkspaceAuth` + `resolveProfileContext`, so
// every handler runs with a resolved `request.profileId`. There is no
// unauthenticated route: an explanation names a workspace's execution evidence,
// so it must be profile-scoped.
//
// The route is intentionally read-only. An explanation is derived from evidence
// that already exists; it is never persisted, so it can never drift from the
// execution it describes.
export const whyInspectorRouter = Router();

whyInspectorRouter.get("/executions/:executionId", explainExecution);
