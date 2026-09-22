// Executable entrypoint for the Tracer CLI.
//
// Responsibilities kept out of `cli.js` so the library stays testable:
//   * load backend/.env (the same file the API uses), then let the shared
//     config loader validate it (with documented standalone placeholders);
//   * translate SIGINT/SIGTERM into cooperative run cancellation, with a second
//     signal forcing immediate exit;
//   * turn the returned exit code into the process exit code.
//
// Run it with `bun run tracer ...` or `bun src/features/cli/main.js ...`.

import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { runCli } from "./cli.js";
import { EXIT_CODES } from "./cli-exit.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

if (import.meta.main) {
	const controller = new AbortController();
	let signals = 0;
	const onSignal = () => {
		signals += 1;
		// First signal cancels gracefully so the run can be reported; a second
		// signal is an explicit "stop now".
		if (signals === 1) controller.abort();
		else process.exit(EXIT_CODES.cancelled);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const code = await runCli(process.argv.slice(2), { abortSignal: controller.signal });
		process.exitCode = code;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}
