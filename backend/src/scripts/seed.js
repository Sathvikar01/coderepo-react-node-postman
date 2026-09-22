import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { initConfig } from "../shared/config/index.js";
import { WorkspaceAccount } from "../features/auth/workspace-account.model.js";
import { Profile } from "../features/profiles/profile.model.js";
import { ProfilePreference } from "../features/profiles/preference.model.js";
import { Collection } from "../features/collections/collection.model.js";
import { Environment } from "../features/environments/environment.model.js";
import { ExecutionHistory } from "../features/history/history.model.js";
import { DemoOrder } from "../features/demo/demo-order.model.js";
import { CollectionRun } from "../features/collection-runner/collection-run.model.js";
import { ProfileCookie } from "../features/cookies/cookie.model.js";
import { Example } from "../features/examples/example.model.js";
import { MinimizationJob } from "../features/execution-intelligence/minimization.model.js";
import { LocalRuntimeSetting } from "../features/local-runtime/local-runtime.model.js";
import { createHash } from "node:crypto";

dotenv.config({ quiet: true });
const config = initConfig();

const id = (suffix) => new mongoose.Types.ObjectId(`64b00000000000000000${suffix}`);

const ACCOUNT_ID = id("a001");
const ALEX_PROFILE_ID = id("a002");
const JORDAN_PROFILE_ID = id("a003");
const ALEX_ORDERS = id("c001");
const ALEX_EXAMPLES = id("c002");
const JORDAN_ORDERS = id("c003");
const JORDAN_EXAMPLES = id("c004");
const ALEX_LOCAL_ENV = id("e001");
const ALEX_STAGING_ENV = id("e002");
const JORDAN_LOCAL_ENV = id("e003");
const JORDAN_STAGING_ENV = id("e004");

let uuidCounter = 0;
const uuid = () => {
	uuidCounter += 1;
	const hash = createHash("sha256").update(`tracer-seed-${uuidCounter}`).digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const row = (key, value, enabled = true) => ({ id: uuid(), key, value, enabled });
const variable = (key, value, enabled = true) => ({ id: uuid(), key, kind: "plain", value, enabled });
const secretRef = (key, alias) => ({ id: uuid(), key, kind: "secretRef", alias, enabled: true });

function ordersRequests(baseUrl) {
	const readFolder = uuid();
	const writeFolder = uuid();
	return {
		folders: [
			{ id: readFolder, name: "Read" },
			{ id: writeFolder, name: "Write" },
		],
		requests: [
			{
				schemaVersion: 1,
				id: uuid(),
				folderId: readFolder,
				name: "List orders",
				method: "GET",
				urlTemplate: `${baseUrl}/orders`,
				query: [row("status", "paid")],
				headers: [],
				body: { mode: "none" },
				auth: { mode: "inherit" },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: uuid(),
				folderId: readFolder,
				name: "Get order",
				method: "GET",
				urlTemplate: `${baseUrl}/orders/{{order_id}}`,
				query: [],
				headers: [],
				body: { mode: "none" },
				auth: { mode: "inherit" },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: uuid(),
				folderId: writeFolder,
				name: "Create order",
				method: "POST",
				urlTemplate: `${baseUrl}/orders`,
				query: [],
				headers: [row("Content-Type", "application/json")],
				body: {
					mode: "json",
					text: '{\n  "customer": "Ada Lovelace",\n  "items": [{ "name": "Keyboard", "quantity": 1, "unitCents": 8900 }]\n}',
				},
				auth: { mode: "inherit" },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: uuid(),
				folderId: writeFolder,
				name: "Update order status",
				method: "PATCH",
				urlTemplate: `${baseUrl}/orders/{{order_id}}`,
				query: [],
				headers: [row("Content-Type", "application/json")],
				body: { mode: "json", text: '{\n  "status": "shipped"\n}' },
				auth: { mode: "inherit" },
				settings: { timeoutMs: 15000 },
			},
			{
				schemaVersion: 1,
				id: uuid(),
				folderId: writeFolder,
				name: "Delete order",
				method: "DELETE",
				urlTemplate: `${baseUrl}/orders/{{order_id}}`,
				query: [],
				headers: [],
				body: { mode: "none" },
				auth: { mode: "inherit" },
				settings: { timeoutMs: 15000 },
			},
		],
	};
}

function exampleRequests(examplesUrl) {
	const request = (name, method, path, auth = { mode: "none" }, extras = {}) => ({
		schemaVersion: 1,
		id: uuid(),
		folderId: null,
		name,
		method,
		urlTemplate: `${examplesUrl}${path}`,
		query: extras.query ?? [],
		headers: extras.headers ?? [],
		body: extras.body ?? { mode: "none" },
		auth,
		settings: { timeoutMs: extras.timeoutMs ?? 15000 },
	});
	return {
		folders: [],
		requests: [
			request("Bearer auth", "GET", "/auth/bearer", { mode: "bearer", tokenTemplate: "{{orders_token}}" }),
			request("Basic auth", "GET", "/auth/basic", {
				mode: "basic",
				usernameTemplate: "{{demo_username}}",
				passwordTemplate: "{{orders_token}}",
			}),
			request("API key header", "GET", "/auth/api-key-header", {
				mode: "apiKey",
				key: "X-API-Key",
				valueTemplate: "{{orders_token}}",
				in: "header",
			}),
			request("API key query", "GET", "/auth/api-key-query", {
				mode: "apiKey",
				key: "api_key",
				valueTemplate: "{{orders_token}}",
				in: "query",
			}),
			request("Echo request", "POST", "/examples/echo", { mode: "none" }, {
				query: [row("source", "tracer")],
				headers: [row("Content-Type", "application/json"), row("X-Demo", "echo")],
				body: { mode: "json", text: '{\n  "hello": "{{customer_name}}"\n}' },
			}),
			request("HEAD echo", "HEAD", "/examples/echo"),
			request("404 status", "GET", "/examples/status/404"),
			request("Delay 1000 ms", "GET", "/examples/delay/1000", { mode: "none" }, { timeoutMs: 5000 }),
			request("Text response", "GET", "/examples/text"),
			request("HTML response", "GET", "/examples/html"),
			request("XML response", "GET", "/examples/xml"),
			request("Invalid JSON", "GET", "/examples/invalid-json"),
			request("Empty response", "GET", "/examples/empty"),
			request("Gzip response", "GET", "/examples/compressed/gzip"),
			request("Deflate response", "GET", "/examples/compressed/deflate"),
			request("Brotli response", "GET", "/examples/compressed/br"),
		],
	};
}
function collectionDocument(ownerProfileId, collectionId, name, description, variables, auth, structure) {
	return {
		_id: collectionId,
		ownerProfileId,
		name,
		nameKey: name.trim().normalize("NFKC").toLowerCase(),
		description,
		variables,
		auth,
		folders: structure.folders,
		requests: structure.requests,
		revision: 1,
	};
}

function environmentDocument(ownerProfileId, environmentId, name, dataset) {
	return {
		_id: environmentId,
		ownerProfileId,
		name,
		nameKey: name.trim().normalize("NFKC").toLowerCase(),
		variables: [
			variable("base_url", `http://127.0.0.1:8000/demo/v1/${dataset}`),
			variable("examples_url", "http://127.0.0.1:8000/demo/v1"),
			secretRef("orders_token", dataset === "local" ? "local_token" : "staging_token"),
			variable("order_id", dataset === "local" ? "ord_0002" : "ord_0004"),
			variable("customer_name", dataset === "local" ? "Ada Lovelace" : "Grace Hopper"),
			variable("demo_username", "tracer"),
		],
		revision: 1,
	};
}

const ORDERS = [
	{
		customer: "Ada Lovelace",
		items: [
			{ name: "Mechanical keyboard", quantity: 1, unitCents: 8900 },
			{ name: "USB-C cable", quantity: 2, unitCents: 1299 },
		],
		status: "paid",
	},
	{ customer: "Grace Hopper", items: [{ name: "Compiler handbook", quantity: 1, unitCents: 5400 }], status: "pending" },
	{ customer: "Alan Turing", items: [{ name: "Notebook", quantity: 3, unitCents: 650 }], status: "shipped" },
	{
		customer: "Katherine Johnson",
		items: [
			{ name: "Orbital chart", quantity: 1, unitCents: 3200 },
			{ name: "Slide rule", quantity: 1, unitCents: 2100 },
		],
		status: "paid",
	},
	{ customer: "Margaret Hamilton", items: [{ name: "Flight software license", quantity: 1, unitCents: 15000 }], status: "pending" },
];

async function seed() {
	const { databaseName, allowedDemoDatabase } = config;
	const host = new URL(config.mongodbUri).hostname;
	if (databaseName !== allowedDemoDatabase)
		throw new Error(`Refusing to seed database "${databaseName}". Expected "${allowedDemoDatabase}".`);
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error(`Refusing to seed a non-local MongoDB host "${host}".`);

	await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 8000 });
	console.log("Connected to MongoDB");
	console.log("Clearing existing application data...");
	await Promise.all([
		WorkspaceAccount.deleteMany({}),
		Profile.deleteMany({}),
		ProfilePreference.deleteMany({}),
		Collection.deleteMany({}),
		Environment.deleteMany({}),
		ExecutionHistory.deleteMany({}),
		DemoOrder.deleteMany({}),
		CollectionRun.deleteMany({}),
		ProfileCookie.deleteMany({}),
		Example.deleteMany({}),
		MinimizationJob.deleteMany({}),
		LocalRuntimeSetting.deleteMany({}),
	]);

	const passwordHash = await bcrypt.hash("password123", 10);
	await WorkspaceAccount.create({
		_id: ACCOUNT_ID,
		name: "Alex Morgan",
		email: "alex.morgan@example.test",
		passwordHash,
		allowedProfileIds: [ALEX_PROFILE_ID, JORDAN_PROFILE_ID],
		active: true,
	});
	await Profile.insertMany([
		{ _id: ALEX_PROFILE_ID, name: "Alex Morgan", email: "alex.morgan@example.test", avatarColor: "#1a73e8", sortOrder: 1 },
		{ _id: JORDAN_PROFILE_ID, name: "Jordan Lee", email: "jordan.lee@example.test", avatarColor: "#188038", sortOrder: 2 },
	]);

	await Collection.insertMany([
		collectionDocument(
			ALEX_PROFILE_ID,
			ALEX_ORDERS,
			"Orders API",
			"Order management endpoints for the local demo target.",
			[variable("api_version", "v1")],
			{ mode: "bearer", tokenTemplate: "{{orders_token}}" },
			ordersRequests("{{base_url}}"),
		),
		collectionDocument(
			ALEX_PROFILE_ID,
			ALEX_EXAMPLES,
			"HTTP Examples",
			"Small targets for inspecting status codes, formats, and timing.",
			[],
			{ mode: "none" },
			exampleRequests("{{examples_url}}"),
		),
		collectionDocument(
			JORDAN_PROFILE_ID,
			JORDAN_ORDERS,
			"Orders API",
			"Order management endpoints for the local demo target.",
			[variable("api_version", "v1")],
			{ mode: "bearer", tokenTemplate: "{{orders_token}}" },
			ordersRequests("{{base_url}}"),
		),
		collectionDocument(
			JORDAN_PROFILE_ID,
			JORDAN_EXAMPLES,
			"HTTP Examples",
			"Small targets for inspecting status codes, formats, and timing.",
			[],
			{ mode: "none" },
			exampleRequests("{{examples_url}}"),
		),
	]);

	await Environment.insertMany([
		environmentDocument(ALEX_PROFILE_ID, ALEX_LOCAL_ENV, "Local", "local"),
		environmentDocument(ALEX_PROFILE_ID, ALEX_STAGING_ENV, "Staging", "staging"),
		environmentDocument(JORDAN_PROFILE_ID, JORDAN_LOCAL_ENV, "Local", "local"),
		environmentDocument(JORDAN_PROFILE_ID, JORDAN_STAGING_ENV, "Staging", "staging"),
	]);

	const alexOrders = await Collection.findById(ALEX_ORDERS).lean();
	const jordanOrders = await Collection.findById(JORDAN_ORDERS).lean();
	await ProfilePreference.insertMany([
		{
			ownerProfileId: ALEX_PROFILE_ID,
			activeEnvironmentId: ALEX_LOCAL_ENV,
			lastSavedRequest: { collectionId: ALEX_ORDERS, requestId: alexOrders.requests[0].id },
			collectionOrder: [ALEX_ORDERS, ALEX_EXAMPLES],
			theme: "dark",
			sidebarCollapsed: false,
			responseView: "pretty",
		},
		{
			ownerProfileId: JORDAN_PROFILE_ID,
			activeEnvironmentId: JORDAN_LOCAL_ENV,
			lastSavedRequest: { collectionId: JORDAN_ORDERS, requestId: jordanOrders.requests[0].id },
			collectionOrder: [JORDAN_ORDERS, JORDAN_EXAMPLES],
			theme: "dark",
			sidebarCollapsed: false,
			responseView: "pretty",
		},
	]);

	const orders = [];
	for (const dataset of ["local", "staging"]) {
		ORDERS.forEach((order, index) => {
			orders.push({
				dataset,
				id: `ord_${String(index + 1).padStart(4, "0")}`,
				customer: order.customer,
				items: order.items,
				totalCents: order.items.reduce((total, item) => total + item.quantity * item.unitCents, 0),
				status: order.status,
			});
		});
	}
	await DemoOrder.insertMany(orders);

	console.log("");
	console.log("Seeding completed successfully!");
	console.log(`  Accounts:     ${await WorkspaceAccount.countDocuments()}`);
	console.log(`  Profiles:     ${await Profile.countDocuments()}`);
	console.log(`  Collections:  ${await Collection.countDocuments()}`);
	console.log(`  Environments: ${await Environment.countDocuments()}`);
	console.log(`  Preferences:  ${await ProfilePreference.countDocuments()}`);
	console.log(`  Demo orders:  ${await DemoOrder.countDocuments()}`);
	console.log(`  Histories:    ${await ExecutionHistory.countDocuments()}`);
	console.log("");
	console.log("Demo sign-in: alex.morgan@example.test / password123 (demo-only credentials)");
	await mongoose.disconnect();
}

seed().catch(async (error) => {
	console.error(`Seeding failed: ${error.message}`);
	await mongoose.disconnect().catch(() => {});
	process.exit(1);
});
