import { Router } from "express";
import { requireWorkspaceCapability, resolveWorkspaceContext } from "../../shared/middleware/workspace-context.js";
import { cancelRun, getRun, listRuns, rerunRun, startRun } from "./collection-runner.controller.js";

export const collectionRunnerRouter = Router();

// Start/rerun resolve current workspace membership and require execute permission.
// List/status/cancel remain profile-scoped lifecycle controls so a collaborator who is
// demoted or removed can still inspect and stop work already started under their profile.
collectionRunnerRouter.get("/", listRuns);
collectionRunnerRouter.post("/", resolveWorkspaceContext, requireWorkspaceCapability("execute"), startRun);
collectionRunnerRouter.get("/:runId", getRun);
collectionRunnerRouter.post("/:runId/cancel", cancelRun);
collectionRunnerRouter.post("/:runId/rerun", resolveWorkspaceContext, requireWorkspaceCapability("execute"), rerunRun);
