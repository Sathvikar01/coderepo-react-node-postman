// Error taxonomy for the CLI.
//
// Every failure that reaches the top level is normalized into a small record
// with a stable `code`, a human `message`, optional non-secret `details`, and the
// exit code the process should use. Errors never carry resolved secret values:
// execution errors are already redacted upstream, and this layer only reshapes
// what it is given.

import { EXIT_CODES } from "./cli-exit.js";

// Thrown by the argument parser and the project/selection resolvers. It always
// means "the caller asked for something we cannot do", never "the server broke".
export class CliError extends Error {
	constructor(message, { code = "CLI_USAGE", details = null, cause = null } = {}) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.details = details;
		this.exitCode = EXIT_CODES.invalidInput;
		if (cause) this.cause = cause;
	}
}

function isAppError(error) {
	return Boolean(error) && typeof error === "object" && typeof error.statusCode === "number" && typeof error.code === "string";
}

// Map any thrown value onto the CLI exit contract. AppError status codes are the
// project's own HTTP contract; 4xx is a caller problem, 5xx is ours.
export function classifyCliError(error) {
	if (error instanceof CliError) {
		return { code: error.code, message: error.message, details: error.details ?? null, exitCode: error.exitCode };
	}
	if (isAppError(error)) {
		const clientSide = error.statusCode >= 400 && error.statusCode < 500;
		return {
			code: error.code,
			message: error.message,
			details: error.details ?? null,
			exitCode: clientSide ? EXIT_CODES.invalidInput : EXIT_CODES.systemFailure,
		};
	}
	return {
		code: error?.code ?? "CLI_FAILURE",
		message: error?.message ? String(error.message) : "The CLI failed unexpectedly.",
		details: null,
		exitCode: EXIT_CODES.systemFailure,
	};
}
