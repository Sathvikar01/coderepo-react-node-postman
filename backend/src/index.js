import dotenv from "dotenv";
import { createApp } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./shared/config/database.js";
import { initConfig } from "./shared/config/index.js";
import { historyService } from "./features/history/history.service.js";

dotenv.config({ quiet: true });

const config = initConfig();
const HOST = "0.0.0.0";

await connectDatabase(config.mongodbUri);
await historyService.recoverInterrupted();

const server = createApp().listen(config.port, HOST, () => {
	console.log(`Request Desk API running on port ${config.port}`);
	console.log(`Environment: ${config.nodeEnv}`);
});

const maintenance = setInterval(async () => {
	try {
		await historyService.reconcileStale();
		await historyService.retentionPass();
	} catch (error) {
		console.error(`Maintenance pass failed: ${error.message}`);
	}
}, 60000);
maintenance.unref();

async function shutdown(signal) {
	console.log(`${signal} received; closing the Request Desk API.`);
	clearInterval(maintenance);
	server.close(async () => {
		await disconnectDatabase();
		process.exit(0);
	});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
