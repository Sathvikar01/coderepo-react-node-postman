import { Router } from "express";
import { clearHistory, deleteHistoryEntry, getHistoryEntry, listHistory } from "./history.controller.js";

export const historyRouter = Router();
historyRouter.get("/", listHistory);
historyRouter.delete("/", clearHistory);
historyRouter.get("/:executionId", getHistoryEntry);
historyRouter.delete("/:executionId", deleteHistoryEntry);
