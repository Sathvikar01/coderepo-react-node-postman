import { Router } from "express";
import {
	cancelInvestigation,
	cancelMinimization,
	compareExecutionRuns,
	exportInvestigationCapsule,
	exportReproCapsule,
	getInvestigation,
	getMinimization,
	getExecutionReceipt,
	importReproCapsule,
	startInvestigation,
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
executionIntelligenceRouter.post("/investigations", startInvestigation);
executionIntelligenceRouter.get("/investigations/:investigationId", getInvestigation);
executionIntelligenceRouter.post("/investigations/:investigationId/cancel", cancelInvestigation);
executionIntelligenceRouter.get("/investigations/:investigationId/capsule", exportInvestigationCapsule);
