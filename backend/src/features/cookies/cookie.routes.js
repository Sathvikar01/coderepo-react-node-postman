import { Router } from "express";
import { clearCookies, deleteCookie, listCookies } from "./cookie.controller.js";

export const cookieRouter = Router();
cookieRouter.get("/", listCookies);
cookieRouter.delete("/", clearCookies);
cookieRouter.delete("/:cookieId", deleteCookie);
