import { Router } from "express";
import { compareExecutionRuns, getExecutionReceipt } from "./execution-intelligence.controller.js";

export const executionIntelligenceRouter = Router();
executionIntelligenceRouter.get("/receipts/:executionId", getExecutionReceipt);
executionIntelligenceRouter.post("/comparisons", compareExecutionRuns);
