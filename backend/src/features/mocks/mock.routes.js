import { Router } from "express";
import { getMockMeta, resolveMock, serveMockRoute } from "./mock.controller.js";

export const mockRouter = Router();
mockRouter.get("/meta", getMockMeta);
mockRouter.post("/resolve", resolveMock);

export const mockRouteRouter = Router();
mockRouteRouter.use("/:profileId/:token", serveMockRoute);
