import { Router } from "express";
import { getLocalRuntime, updateLocalRuntime } from "./local-runtime.controller.js";

export const localRuntimeRouter = Router();
localRuntimeRouter.get("/", getLocalRuntime);
localRuntimeRouter.put("/", updateLocalRuntime);
