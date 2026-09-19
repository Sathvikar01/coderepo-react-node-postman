import { Router } from "express";
import {
	createEnvironment,
	deleteEnvironment,
	getEnvironment,
	listEnvironments,
	listSecretAliases,
	updateEnvironment,
} from "./environment.controller.js";

export const environmentRouter = Router();
environmentRouter.get("/secret-aliases", listSecretAliases);
environmentRouter.get("/", listEnvironments);
environmentRouter.post("/", createEnvironment);
environmentRouter.get("/:environmentId", getEnvironment);
environmentRouter.put("/:environmentId", updateEnvironment);
environmentRouter.delete("/:environmentId", deleteEnvironment);
