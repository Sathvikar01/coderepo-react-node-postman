import { Router } from "express";
import { getPreferences, listProfiles, updatePreferences } from "./profile.controller.js";

export const profileRouter = Router();
profileRouter.get("/", listProfiles);

export const preferenceRouter = Router();
preferenceRouter.get("/", getPreferences);
preferenceRouter.put("/", updatePreferences);
