import mongoose from "mongoose";

const TEST_DATABASE_URI = process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017/request_desk_phase3_test";
const databaseName = new URL(TEST_DATABASE_URI).pathname.replace(/^\//, "");

export async function connectTestDatabase() {
	if (!databaseName.endsWith("_test")) return false;
	if (mongoose.connection.readyState === 1) return true;
	try {
		await mongoose.connect(TEST_DATABASE_URI, { serverSelectionTimeoutMS: 750 });
		return true;
	} catch {
		return false;
	}
}

export async function disconnectTestDatabase() {
	if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
