// Configuration bootstrap for the standalone CLI.
//
// The CLI talks to no database and serves no HTTP, but the shared config loader
// (`initConfig`) requires a few variables because the same loader also protects
// the API process. Rather than weakening the shared loader, the CLI supplies
// clearly-labelled, non-secret placeholders for values it never uses:
//
//   * MONGODB_URI                  never connected
//   * JWT_SECRET                   never used to sign or verify anything
//   * EXECUTION_FINGERPRINT_KEY    only keys local evidence HMACs
//
// A caller who wants fingerprints to match the API sets EXECUTION_FINGERPRINT_KEY
// explicitly; tests do exactly that. The placeholders are fixed strings, not
// credentials, and are documented as such. Server secret aliases still resolve
// only through SERVER_SECRET_ALIASES_JSON plus DEMO_* variables, so real target
// secrets follow exactly the same path as the server and are never persisted.

import { initConfig } from "../../shared/config/index.js";
import { CliError } from "./cli-errors.js";

export const STANDALONE_DEFAULTS = Object.freeze({
	MONGODB_URI: "mongodb://127.0.0.1:27017/tracer_cli",
	JWT_SECRET: "tracer-cli-standalone-jwt-secret",
	EXECUTION_FINGERPRINT_KEY: "tracer-cli-standalone-fingerprint-key",
});

// Returns which placeholders were needed so the report can say so honestly.
export function applyStandaloneDefaults(env = process.env) {
	const applied = [];
	for (const [key, value] of Object.entries(STANDALONE_DEFAULTS)) {
		if (!env[key]) {
			env[key] = value;
			applied.push(key);
		}
	}
	return { standalone: applied.length > 0, applied };
}

// A malformed configuration is a user-fixable input problem, not a crash, so it
// is reported as CLI_CONFIG with the invalid-input exit code instead of leaking a
// raw loader stack trace.
function configError(error) {
	if (error instanceof CliError) return error;
	return new CliError(`Invalid configuration: ${error?.message ?? "the configuration could not be loaded."}`, {
		code: "CLI_CONFIG",
	});
}

export function loadCliConfig(env = process.env, { loader = initConfig } = {}) {
	const defaults = applyStandaloneDefaults(env);
	try {
		return { config: loader(), ...defaults };
	} catch (error) {
		throw configError(error);
	}
}
