import { Router } from "express";
import {
	compareExecutionRuns,
	exportReproCapsule,
	getExecutionReceipt,
	importReproCapsule,
} from "./execution-intelligence.controller.js";

export const executionIntelligenceRouter = Router();
executionIntelligenceRouter.get("/receipts/:executionId", getExecutionReceipt);
executionIntelligenceRouter.post("/comparisons", compareExecutionRuns);
executionIntelligenceRouter.post("/capsules/export", exportReproCapsule);
executionIntelligenceRouter.post("/capsules/import", importReproCapsule);
