import { Router } from "express";
import { cancelExecution, getExecution, sendExecution } from "./execution.controller.js";

export const executionRouter = Router();
executionRouter.post("/", sendExecution);
executionRouter.get("/:executionId", getExecution);
executionRouter.post("/:executionId/cancel", cancelExecution);
