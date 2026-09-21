import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { authRouter } from "./features/auth/auth.routes.js";
import { collectionRouter } from "./features/collections/collection.routes.js";
import { cookieRouter } from "./features/cookies/cookie.routes.js";
import { demoRouter } from "./features/demo/demo.routes.js";
import { environmentRouter } from "./features/environments/environment.routes.js";
import { executionRouter } from "./features/executions/execution.routes.js";
import { historyRouter } from "./features/history/history.routes.js";
import { localRuntimeRouter } from "./features/local-runtime/local-runtime.routes.js";
import { preferenceRouter, profileRouter } from "./features/profiles/profile.routes.js";
import { errorHandler, notFoundHandler } from "./shared/middleware/error-handler.js";
import { requireWorkspaceAuth } from "./shared/middleware/auth.js";
import { resolveProfileContext } from "./shared/middleware/profile-context.js";
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

	app.use(
		"/api/v1/preferences",
		express.json({ limit: LIMITS.jsonBodyEnvironment }),
		requireWorkspaceAuth,
		resolveProfileContext,
		preferenceRouter,
	);
	app.use(
		"/api/v1/collections",
		express.json({ limit: LIMITS.jsonBodyCollection }),
		requireWorkspaceAuth,
		resolveProfileContext,
		collectionRouter,
	);
	app.use(
		"/api/v1/environments",
		express.json({ limit: LIMITS.jsonBodyEnvironment }),
		requireWorkspaceAuth,
		resolveProfileContext,
		environmentRouter,
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
	app.use("/api/v1/history", express.json({ limit: LIMITS.jsonBodyDefault }), requireWorkspaceAuth, resolveProfileContext, historyRouter);
	app.use(
		"/api/v1/local-runtime",
		express.json({ limit: LIMITS.jsonBodyDefault }),
		requireWorkspaceAuth,
		resolveProfileContext,
		localRuntimeRouter,
	);

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}
