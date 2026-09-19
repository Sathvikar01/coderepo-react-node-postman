import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";
import { demoRepository } from "./demo.repository.js";

const DATASETS = new Set(["local", "staging"]);

export function datasetToken(dataset) {
	return dataset === "staging" ? process.env.DEMO_STAGING_TOKEN : process.env.DEMO_LOCAL_TOKEN;
}

// Constant-time comparison using node:crypto only. Both values are hashed to a fixed
// 32-byte digest first, so timingSafeEqual always receives equal-length buffers and
// neither the length nor the content of the expected token can leak through timing.
function tokensMatch(candidate, expected) {
	if (!expected || !candidate) return false;
	const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
	const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
	return timingSafeEqual(candidateDigest, expectedDigest);
}

export function requireTargetAuth(request, dataset) {
	if (!DATASETS.has(dataset)) throw new AppError(404, "DATASET_NOT_FOUND", "The requested demo dataset does not exist.");
	const authorization = request.get("authorization") || "";
	if (!authorization.startsWith("Bearer ")) throw new AppError(401, "TARGET_AUTH_REQUIRED", "This demo target requires a bearer token.");
	const token = authorization.slice(7).trim();
	if (!tokensMatch(token, datasetToken(dataset)))
		throw new AppError(401, "TARGET_AUTH_INVALID", "The bearer token is not valid for this demo dataset.");
}

export const demoService = {
	list: (dataset, query) => demoRepository.list(dataset, query),
	async get(dataset, id) {
		const order = await demoRepository.findById(dataset, id);
		if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "The requested order does not exist.");
		return order;
	},
	async create(dataset, input) {
		const nextId = await nextOrderId(dataset);
		const items = input.items.map((item) => ({ ...item, unitCents: item.unitCents ?? 0 }));
		const totalCents = items.reduce((total, item) => total + item.quantity * item.unitCents, 0);
		return demoRepository.create({
			dataset,
			id: nextId,
			customer: input.customer,
			items,
			totalCents,
			status: input.status ?? "pending",
		});
	},
	async update(dataset, id, input) {
		const existing = await demoRepository.findById(dataset, id);
		if (!existing) throw new AppError(404, "ORDER_NOT_FOUND", "The requested order does not exist.");
		const update = { ...input };
		if (input.items) {
			update.items = input.items;
			update.totalCents = input.items.reduce((total, item) => total + item.quantity * (item.unitCents ?? 0), 0);
		}
		return demoRepository.update(dataset, id, update);
	},
	async remove(dataset, id) {
		const removed = await demoRepository.remove(dataset, id);
		if (!removed) throw new AppError(404, "ORDER_NOT_FOUND", "The requested order does not exist.");
		return removed;
	},
};

async function nextOrderId(dataset) {
	const orders = await demoRepository.list(dataset);
	const highest = orders.reduce((max, order) => Math.max(max, Number.parseInt(order.id.replace(/\D/g, ""), 10) || 0), 0);
	return `ord_${String(highest + 1).padStart(4, "0")}`;
}
