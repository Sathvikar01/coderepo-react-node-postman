import { Router } from "express";
import {
	addWorkspaceMember,
	changeWorkspaceMemberRole,
	createWorkspace,
	getWorkspace,
	listWorkspaceActivity,
	listWorkspaces,
	removeWorkspaceMember,
	renameWorkspace,
	streamWorkspaceEvents,
} from "./workspace.controller.js";

export const workspaceRouter = Router();
workspaceRouter.get("/", listWorkspaces);
workspaceRouter.post("/", createWorkspace);
workspaceRouter.get("/:workspaceId", getWorkspace);
workspaceRouter.put("/:workspaceId", renameWorkspace);
workspaceRouter.post("/:workspaceId/members", addWorkspaceMember);
workspaceRouter.put("/:workspaceId/members/:profileId", changeWorkspaceMemberRole);
workspaceRouter.delete("/:workspaceId/members/:profileId", removeWorkspaceMember);
workspaceRouter.get("/:workspaceId/activity", listWorkspaceActivity);
workspaceRouter.get("/:workspaceId/events", streamWorkspaceEvents);
