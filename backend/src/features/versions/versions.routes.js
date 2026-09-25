import { Router } from "express";
import { compareVersions, getVersion, listVersions, restoreVersion } from "./versions.controller.js";

// Phase 24B — version history surfaces. Each router mounts under its resource
// prefix with the same auth + workspace-context chain as the resource itself,
// so membership and role gates behave identically without touching the existing
// routers. The routers stay prefix-scoped (never a bare /api/v1 mount) so
// unrelated routes can never fall through version middleware.
export const collectionVersionsRouter = Router();
collectionVersionsRouter.get("/:collectionId/versions", listVersions);
collectionVersionsRouter.get("/:collectionId/versions/:revisionA/compare/:revisionB", compareVersions);
collectionVersionsRouter.get("/:collectionId/versions/:revision", getVersion);
collectionVersionsRouter.post("/:collectionId/restore", restoreVersion);

export const environmentVersionsRouter = Router();
environmentVersionsRouter.get("/:environmentId/versions", listVersions);
environmentVersionsRouter.get("/:environmentId/versions/:revisionA/compare/:revisionB", compareVersions);
environmentVersionsRouter.get("/:environmentId/versions/:revision", getVersion);
environmentVersionsRouter.post("/:environmentId/restore", restoreVersion);
