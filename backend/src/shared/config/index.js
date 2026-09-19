function getRequiredEnv(key) {
	const value = process.env[key];
	if (!value) throw new Error(`Missing required environment variable: ${key}`);
	return value;
}

function getOptionalEnv(key, defaultValue) {
	return process.env[key] || defaultValue;
}

function getIntEnv(key, defaultValue) {
	const parsed = Number.parseInt(process.env[key] || "", 10);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

const ALLOWED_DEMO_DATABASE = "request_desk_demo";

let configInstance = null;

function parseSecretAliases(raw) {
	if (!raw) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("SERVER_SECRET_ALIASES_JSON is not valid JSON.");
	}
	if (!Array.isArray(parsed)) throw new Error("SERVER_SECRET_ALIASES_JSON must be a JSON array.");
	const seen = new Set();
	return parsed.map((entry) => {
		const alias = String(entry?.alias ?? "").trim();
		const env = String(entry?.env ?? "").trim();
		const profileIds = Array.isArray(entry?.profileIds) ? entry.profileIds.map(String) : [];
		if (!alias || seen.has(alias))
			throw new Error(`SERVER_SECRET_ALIASES_JSON contains a missing or duplicate alias: ${alias || "(blank)"}`);
		if (!/^DEMO_[A-Z0-9_]+$/.test(env))
			throw new Error(`Secret alias "${alias}" must reference an allowed DEMO_* target-secret variable.`);
		const value = process.env[env];
		if (!value) throw new Error(`Secret alias "${alias}" references ${env}, which is not configured.`);
		seen.add(alias);
		return { alias, env, profileIds, value };
	});
}

export function loadConfig() {
	const mongodbUri = getRequiredEnv("MONGODB_URI");
	const fingerprintKey = getRequiredEnv("EXECUTION_FINGERPRINT_KEY");
	if (fingerprintKey.length < 16) throw new Error("EXECUTION_FINGERPRINT_KEY must be at least 16 characters.");
	const databaseName = new URL(mongodbUri).pathname.replace(/^\//, "");
	configInstance = {
		mongodbUri,
		databaseName,
		allowedDemoDatabase: ALLOWED_DEMO_DATABASE,
		jwtSecret: getRequiredEnv("JWT_SECRET"),
		jwtExpiresIn: getOptionalEnv("JWT_EXPIRES_IN", "24h"),
		jwtIssuer: "request-desk-api",
		jwtAudience: "request-desk-app",
		fingerprintKey,
		fingerprintKeyId: getOptionalEnv("EXECUTION_FINGERPRINT_KEY_ID", "v1"),
		secretAliases: parseSecretAliases(getOptionalEnv("SERVER_SECRET_ALIASES_JSON", "")),
		port: getIntEnv("PORT", 8000),
		nodeEnv: getOptionalEnv("NODE_ENV", "development"),
		execution: {
			minTimeoutMs: 100,
			maxTimeoutMs: 30000,
			defaultTimeoutMs: 15000,
			finalizeTimeoutMs: 3000,
			maxConcurrentPerProfile: 3,
			maxConcurrentPerProcess: 20,
			sendRatePerMinute: 60,
			sendBurst: 10,
			statusRatePerMinute: 120,
			statusBurst: 20,
			staleRunningMs: 45000,
			retentionDays: 7,
			retainedBodyRecords: 200,
		},
	};
	return configInstance;
}

export function getConfig() {
	if (!configInstance) throw new Error("Configuration not loaded. Call initConfig() first after dotenv.config()");
	return configInstance;
}

export function initConfig() {
	configInstance = loadConfig();
	return configInstance;
}

export { getRequiredEnv, getOptionalEnv };
