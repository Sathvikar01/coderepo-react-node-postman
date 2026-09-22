// Runtime wiring for the CLI.
//
// This assembles the same services the API process uses — the real compiler,
// target policy, transport, capture, script runner, assertion runner, cookies,
// and collection runner — over in-memory storage. There is no alternate
// execution path: a CLI run step is an ordinary `executionService.send`, so
// policy, DNS pinning, redaction, scripts, assertions, and receipts behave
// exactly as they do for a manual send or a workspace collection run.
//
// Every collaborator is injectable so tests can supply a fake transport or a
// permissive policy while still driving the real runner service.

import { createCookieService } from "../cookies/cookie.service.js";
import { createCollectionRunnerService } from "../collection-runner/collection-runner.service.js";
import { environmentService } from "../environments/environment.service.js";
import { createOperationRegistry } from "../executions/active-registry.js";
import { createExecutionService } from "../executions/execution.service.js";
import { performRequest } from "../executions/http-transport.js";
import { createTargetPolicy } from "../executions/target-policy.js";
import {
	createMemoryCollectionRunRepository,
	createMemoryCollectionStore,
	createMemoryCookieRepository,
	createMemoryEnvironmentStore,
	createMemoryHistoryStore,
	createMemoryLocalRuntime,
} from "./memory-stores.js";

export function createCliRuntime({ collections, environments, profileId, allowLocal = [], overrides = {} }) {
	const registry = overrides.registry ?? createOperationRegistry();
	const history = overrides.history ?? createMemoryHistoryStore();
	const cookieRepository = overrides.cookieRepository ?? createMemoryCookieRepository();
	const cookies =
		overrides.cookies ??
		createCookieService({
			repository: cookieRepository,
			// The in-memory jar is always available; there is no connection to await.
			isStoreReady: () => true,
			sessionId: `tracer-cli-${profileId}`,
		});
	const localRuntime = overrides.localRuntime ?? createMemoryLocalRuntime(allowLocal);
	const collectionStore = createMemoryCollectionStore(collections, profileId);
	const environmentStore = createMemoryEnvironmentStore(environments, profileId);
	const executions =
		overrides.executions ??
		createExecutionService({
			registry,
			history,
			cookies,
			transport: overrides.transport ?? performRequest,
			policy: overrides.policy ?? null,
			localRuntime,
			collections: collectionStore,
			environments: environmentStore,
			environmentSecrets: overrides.environmentSecrets ?? environmentService,
		});
	const repository = overrides.repository ?? createMemoryCollectionRunRepository();
	const runners =
		overrides.runners ??
		createCollectionRunnerService({
			repository,
			collections: collectionStore,
			environments: environmentStore,
			executions,
		});
	return { registry, history, cookieRepository, cookies, localRuntime, executions, repository, runners };
}
