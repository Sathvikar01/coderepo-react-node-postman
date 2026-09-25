import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../../app.js", import.meta.url)), "utf8");
const executionRoutes = readFileSync(
	fileURLToPath(new URL("../executions/execution.routes.js", import.meta.url)),
	"utf8",
);
const runnerRoutes = readFileSync(
	fileURLToPath(new URL("../collection-runner/collection-runner.routes.js", import.meta.url)),
	"utf8",
);

describe("collaboration lifecycle route gates", () => {
	test("execution status and cancel are not trapped behind workspace membership", () => {
		expect(app).toContain('"/api/v1/executions"');
		expect(executionRoutes).toContain(
			'executionRouter.post("/", resolveWorkspaceContext, requireWorkspaceCapability("execute"), sendExecution);',
		);
		expect(executionRoutes).toContain('executionRouter.get("/:executionId", getExecution);');
		expect(executionRoutes).toContain('executionRouter.post("/:executionId/cancel", cancelExecution);');
		expect(executionRoutes).not.toContain(
			'executionRouter.get("/:executionId", resolveWorkspaceContext',
		);
		expect(executionRoutes).not.toContain(
			'executionRouter.post("/:executionId/cancel", resolveWorkspaceContext',
		);
	});

	test("runner list/status/cancel stay profile-owned while start and rerun require workspace execute", () => {
		expect(app).toContain('"/api/v1/collection-runs"');
		expect(runnerRoutes).toContain(
			'collectionRunnerRouter.post("/", resolveWorkspaceContext, requireWorkspaceCapability("execute"), startRun);',
		);
		expect(runnerRoutes).toContain(
			'collectionRunnerRouter.post("/:runId/rerun", resolveWorkspaceContext, requireWorkspaceCapability("execute"), rerunRun);',
		);
		expect(runnerRoutes).toContain('collectionRunnerRouter.get("/", listRuns);');
		expect(runnerRoutes).toContain('collectionRunnerRouter.get("/:runId", getRun);');
		expect(runnerRoutes).toContain('collectionRunnerRouter.post("/:runId/cancel", cancelRun);');
		expect(runnerRoutes).not.toContain('collectionRunnerRouter.get("/", resolveWorkspaceContext');
		expect(runnerRoutes).not.toContain(
			'collectionRunnerRouter.post("/:runId/cancel", resolveWorkspaceContext',
		);
	});
});
