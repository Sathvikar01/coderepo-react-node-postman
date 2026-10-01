import { Router } from "express";
import { requireWorkspaceCapability } from "../../shared/middleware/workspace-context.js";
import { analyzeChangeSafety, runChangeSafety } from "./change-safety.controller.js";

// Phase 54 — one browser transport for the existing change-safety cores.
//
// Read-only analysis is available to any workspace reader. Starting a rehearsal
// dispatches real requests through the normal execution path, so it requires the
// workspace's existing execute capability.
export const changeSafetyRouter = Router();

changeSafetyRouter.post("/analyze", requireWorkspaceCapability("read"), analyzeChangeSafety);
changeSafetyRouter.post("/run", requireWorkspaceCapability("execute"), runChangeSafety);
