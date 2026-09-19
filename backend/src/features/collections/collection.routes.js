import { Router } from "express";
import { createCollection, deleteCollection, duplicateCollection, getCollection, listCollections, updateCollection } from "./collection.controller.js";

export const collectionRouter = Router();
collectionRouter.get("/", listCollections);
collectionRouter.post("/", createCollection);
collectionRouter.get("/:collectionId", getCollection);
collectionRouter.put("/:collectionId", updateCollection);
collectionRouter.post("/:collectionId/duplicate", duplicateCollection);
collectionRouter.delete("/:collectionId", deleteCollection);
