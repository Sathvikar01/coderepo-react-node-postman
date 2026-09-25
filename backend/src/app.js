import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { authRouter } from "./features/auth/auth.routes.js";
import { collectionRouter } from "./features/collections/collection.routes.js";
import { collectionRunnerRouter } from "./features/collection-runner/collection-runner.routes.js";
import { cookieRouter } from "./features/cookies/cookie.routes.js";
import { demoRouter } from "./features/demo/demo.routes.js";
import { environmentRouter } from "./features/environments/environment.routes.js";
import { exampleRouter } from "./features/examples/example.routes.js";
import { executionRouter } from "./features/executions/execution.routes.js";
import { executionIntelligenceRouter } from "./features/execution-intelligence/execution-intelligence.routes.js";
import { historyRouter } from "./features/history/history.routes.js";
import { localRuntimeRouter } from "./features/local-runtime/local-runtime.routes.js";
import { mockRouteRouter, mockRouter } from "./features/mocks/mock.routes.js";
import { preferenceRouter, profileRouter } from "./features/profiles/profile.routes.js";
import { verificationProofRouter } from "./features/verification-proof-api/verification-proof.routes.js";
import { collectionVersionsRouter, environmentVersionsRouter } from "./features/versions/versions.routes.js";
import { whyInspectorRouter } from "./features/why-inspector/why-inspector.routes.js";
import { workspaceRouter } from "./features/workspaces/workspace.routes.js";
import { errorHandler, notFoundHandler } from "./shared/middleware/error-handler.js";
import { requireWorkspaceAuth } from "./shared/middleware/auth.js";
import { resolveProfileContext } from "./shared/middleware/profile-context.js";
import { resolveWorkspaceContext } from "./shared/middleware/workspace-context.js";
import { LIMITS } from "./shared/utils/limits.js";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function allowedOrigins() {
	return (process.env.APP_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function createApp() {
	const app = express();
	app.disable("x-powered-by");
	const origins = allowedOrigins();
	app.use(
		cors({
			credentials: false,
			origin(origin, callback) {
				if (!origin || origins.includes(origin)) return callback(null, true);
				return callback(null, false);
			},
		}),
	);
	app.use((request, response, next) => {
		response.set("Vary", "Origin");
		next();
	});
	app.use(express.static(publicDirectory));
	app.get("/api/v1/health", (request, response) => {
		const database = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
		response
			.status(database === "connected" ? 200 : 503)
			.json({ data: { status: database === "connected" ? "ok" : "degraded", database } });
	});

	app.use("/demo", express.json({ limit: LIMITS.jsonBodyExecution }), demoRouter);

	app.use("/api/v1/auth", express.json({ limit: LIMITS.jsonBodyDefault }), authRouter);
	app.use("/api/v1/profiles", express.json({ limit: LIMITS.jsonBodyDefault }), requireWorkspaceAuth, profileRouter);

	// Shared-workspace collaboration: membership, roles, sharing, and the bounded
	// activity feed. The workspace router resolves its own membership per route, so it
	// does not mount `resolveWorkspaceContext`.
	app.use(
		"/api/v1/workspaces",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		workspaceRouter,
	);

	app.use(
		"/api/v1/preferences",
		express.json({ limit: LIMITS.jsonBodyEnvironment }),
		requireWorkspaceAuth,
		resolveProfileContext,
		resolveWorkspaceContext,
		preferenceRouter,
	);
	app.use(
		"/api/v1/collections",
		express.json({ limit: LIMITS.jsonBodyCollection }),
		requireWorkspaceAuth,
		resolveProfileContext,
		resolveWorkspaceContext,
		collectionRouter,
	);
	app.use(
		"/api/v1/collection-runs",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		collectionRunnerRouter,
	);
	app.use(
		"/api/v1/environments",
		express.json({ limit: LIMITS.jsonBodyEnvironment }),
		requireWorkspaceAuth,
		resolveProfileContext,
		resolveWorkspaceContext,
		environmentRouter,
	);
	// Phase 24B — version history shares each resource's auth and
	// workspace-context chain, so membership and role gates behave identically.
	// The routers stay prefix-scoped so unrelated routes never pass through
	// version middleware.
	app.use(
		"/api/v1/collections",
		express.json({ limit: LIMITS.jsonBodyCollection }),
		requireWorkspaceAuth,
		resolveProfileContext,
		resolveWorkspaceContext,
		collectionVersionsRouter,
	);
	app.use(
		"/api/v1/environments",
		express.json({ limit: LIMITS.jsonBodyEnvironment }),
		requireWorkspaceAuth,
		resolveProfileContext,
		resolveWorkspaceContext,
		environmentVersionsRouter,
	);
	app.use(
		"/api/v1/cookies",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		cookieRouter,
	);
	app.use(
		"/api/v1/executions",
		express.json({ limit: LIMITS.jsonBodyExecution }),
		requireWorkspaceAuth,
		resolveProfileContext,
		executionRouter,
	);
	app.use(
		"/api/v1/execution-intelligence",
		express.json({ limit: LIMITS.jsonBodyExecution }),
		requireWorkspaceAuth,
		resolveProfileContext,
		executionIntelligenceRouter,
	);
	app.use("/api/v1/history", express.json({ limit: LIMITS.jsonBodyDefault }), requireWorkspaceAuth, resolveProfileContext, historyRouter);
	app.use(
		"/api/v1/local-runtime",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		localRuntimeRouter,
	);
	app.use(
		"/api/v1/examples",
		express.json({ limit: LIMITS.jsonBodyCollection }),
		requireWorkspaceAuth,
		resolveProfileContext,
		exampleRouter,
	);
	app.use(
		"/api/v1/verification-proofs",
		express.json({ limit: LIMITS.jsonBodyProofArtifact }),
		requireWorkspaceAuth,
		resolveProfileContext,
		verificationProofRouter,
	);
	// Phase 49 — "Why?" Inspector. A read-only projection over already-recorded
	// execution evidence. Never persisted, so it cannot drift from the execution.
	app.use(
		"/api/v1/why",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		whyInspectorRouter,
	);

	// Capability-token mock routes stay unauthenticated by design and never reach the execution pipeline.
	app.use("/api/v1/mocks", express.json({ limit: LIMITS.jsonBodyDefault }), mockRouteRouter);
	app.use("/api/v1/mocks", express.json({ limit: LIMITS.jsonBodyExecution }), requireWorkspaceAuth, resolveProfileContext, mockRouter);

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}
