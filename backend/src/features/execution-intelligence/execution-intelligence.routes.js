import { Router } from "express";
import {
	compareExecutionRuns,
	cancelMinimization,
	exportReproCapsule,
	getMinimization,
	getExecutionReceipt,
	importReproCapsule,
	startMinimization,
} from "./execution-intelligence.controller.js";

export const executionIntelligenceRouter = Router();
executionIntelligenceRouter.get("/receipts/:executionId", getExecutionReceipt);
executionIntelligenceRouter.post("/comparisons", compareExecutionRuns);
executionIntelligenceRouter.post("/capsules/export", exportReproCapsule);
executionIntelligenceRouter.post("/capsules/import", importReproCapsule);
executionIntelligenceRouter.post("/minimizations", startMinimization);
executionIntelligenceRouter.get("/minimizations/:jobId", getMinimization);
executionIntelligenceRouter.post("/minimizations/:jobId/cancel", cancelMinimization);
