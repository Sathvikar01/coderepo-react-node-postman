import { Router } from "express";
import { requireWorkspaceCapability } from "../../shared/middleware/workspace-context.js";
import { cancelRun, getRun, listRuns, rerunRun, startRun } from "./collection-runner.controller.js";

export const collectionRunnerRouter = Router();

// Starting or repeating a run requires execute permission. Read/cancel endpoints
// remain profile-scoped lifecycle controls so a demoted collaborator can still
// observe and stop work that was already started under their profile.
collectionRunnerRouter.get("/", listRuns);
collectionRunnerRouter.post("/", requireWorkspaceCapability("execute"), startRun);
collectionRunnerRouter.get("/:runId", getRun);
collectionRunnerRouter.post("/:runId/cancel", cancelRun);
collectionRunnerRouter.post("/:runId/rerun", requireWorkspaceCapability("execute"), rerunRun);
