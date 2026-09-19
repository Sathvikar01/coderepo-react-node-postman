import { z } from "zod";
import { collectionAggregateSchema } from "../../shared/utils/schemas.js";
import { collectionService } from "./collection.service.js";

const revisionSchema = z.coerce.number().int().min(1);
const createSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		description: z.string().max(1000).optional(),
		variables: collectionAggregateSchema.shape.variables.optional(),
		auth: collectionAggregateSchema.shape.auth.optional(),
	})
	.strict();
const updateSchema = z.object({ expectedRevision: revisionSchema, collection: collectionAggregateSchema }).strict();
const duplicateSchema = z.object({ expectedRevision: revisionSchema, name: z.string().trim().min(1).max(80) }).strict();
const deleteQuerySchema = z.object({ revision: revisionSchema }).strict();

export async function listCollections(request, response, next) {
	try {
		response.json({ data: await collectionService.list(request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function getCollection(request, response, next) {
	try {
		response.json({ data: await collectionService.get(request.params.collectionId, request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function createCollection(request, response, next) {
	try {
		response.status(201).json({ data: await collectionService.create(createSchema.parse(request.body), request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function updateCollection(request, response, next) {
	try {
		const { expectedRevision, collection } = updateSchema.parse(request.body);
		response.json({
			data: await collectionService.replace(request.params.collectionId, request.profileId, expectedRevision, collection),
		});
	} catch (error) {
		next(error);
	}
}

export async function duplicateCollection(request, response, next) {
	try {
		const { expectedRevision, name } = duplicateSchema.parse(request.body);
		response
			.status(201)
			.json({ data: await collectionService.duplicate(request.params.collectionId, request.profileId, expectedRevision, name) });
	} catch (error) {
		next(error);
	}
}

export async function deleteCollection(request, response, next) {
	try {
		const { revision } = deleteQuerySchema.parse(request.query);
		await collectionService.remove(request.params.collectionId, request.profileId, revision);
		response.status(204).send();
	} catch (error) {
		next(error);
	}
}
