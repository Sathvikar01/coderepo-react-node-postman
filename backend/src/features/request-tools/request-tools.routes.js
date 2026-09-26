import { Router } from "express";
import { generateCodeSnippet, parseCurlImport } from "./request-tools.controller.js";

export const requestToolsRouter = Router();

requestToolsRouter.post("/import-curl", parseCurlImport);
requestToolsRouter.post("/snippet", generateCodeSnippet);
