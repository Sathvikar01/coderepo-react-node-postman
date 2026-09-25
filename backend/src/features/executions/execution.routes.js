import { Router } from "express";
import { requireWorkspaceCapability } from "../../shared/middleware/workspace-context.js";
import { cancelExecution, getExecution, sendExecution } from "./execution.controller.js";

export const executionRouter = Router();

// Starting new remote work requires the current workspace's execute capability.
// Status and cancellation remain profile-owned lifecycle controls so a role
// downgrade can stop future sends without trapping an already-running request.
executionRouter.post("/", requireWorkspaceCapability("execute"), sendExecution);
executionRouter.get("/:executionId", getExecution);
executionRouter.post("/:executionId/cancel", cancelExecution);
