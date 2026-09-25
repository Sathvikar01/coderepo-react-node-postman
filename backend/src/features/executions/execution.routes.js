import { Router } from "express";
import { requireWorkspaceCapability, resolveWorkspaceContext } from "../../shared/middleware/workspace-context.js";
import { cancelExecution, getExecution, sendExecution } from "./execution.controller.js";

export const executionRouter = Router();

// Starting new remote work resolves current workspace membership and requires execute.
// Status/cancel stay profile-owned lifecycle controls: a demotion or removal may stop
// future sends immediately, but can never strand an already-running request.
executionRouter.post("/", resolveWorkspaceContext, requireWorkspaceCapability("execute"), sendExecution);
executionRouter.get("/:executionId", getExecution);
executionRouter.post("/:executionId/cancel", cancelExecution);
