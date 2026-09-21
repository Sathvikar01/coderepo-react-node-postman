import { Router } from "express";
import { createExample, deleteExample, getExample, listExamples, updateExample } from "./example.controller.js";

export const exampleRouter = Router();
exampleRouter.get("/", listExamples);
exampleRouter.post("/", createExample);
exampleRouter.get("/:exampleId", getExample);
exampleRouter.put("/:exampleId", updateExample);
exampleRouter.delete("/:exampleId", deleteExample);
