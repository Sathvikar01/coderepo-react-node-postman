import { Router } from "express";
import { cancelRun, getRun, listRuns, rerunRun, startRun } from "./collection-runner.controller.js";

export const collectionRunnerRouter = Router();
collectionRunnerRouter.get("/", listRuns);
collectionRunnerRouter.post("/", startRun);
collectionRunnerRouter.get("/:runId", getRun);
collectionRunnerRouter.post("/:runId/cancel", cancelRun);
collectionRunnerRouter.post("/:runId/rerun", rerunRun);
