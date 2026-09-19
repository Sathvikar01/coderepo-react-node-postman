import { z } from "zod";
import { variablesSchema } from "../../shared/utils/schemas.js";
import { environmentService } from "./environment.service.js";

const revisionSchema = z.coerce.number().int().min(1);
const createSchema = z.object({ name: z.string().trim().min(1).max(80), variables: variablesSchema.default([]) }).strict();
const updateSchema = z.object({ expectedRevision: revisionSchema, environment: z.object({ name: z.string().trim().min(1).max(80), variables: variablesSchema }).strict() }).strict();
const deleteQuerySchema = z.object({ revision: revisionSchema }).strict();

export async function listEnvironments(request, response, next) {
    try {
        response.json({ data: await environmentService.list(request.profileId) });
    } catch (error) {
        next(error);
    }
}

export async function getEnvironment(request, response, next) {
    try {
        response.json({ data: await environmentService.get(request.params.environmentId, request.profileId) });
    } catch (error) {
        next(error);
    }
}

export async function createEnvironment(request, response, next) {
    try {
        response.status(201).json({ data: await environmentService.create(createSchema.parse(request.body), request.profileId) });
    } catch (error) {
        next(error);
    }
}

export async function updateEnvironment(request, response, next) {
    try {
        const { expectedRevision, environment } = updateSchema.parse(request.body);
        response.json({ data: await environmentService.replace(request.params.environmentId, request.profileId, expectedRevision, environment) });
    } catch (error) {
        next(error);
    }
}

export async function deleteEnvironment(request, response, next) {
    try {
        const { revision } = deleteQuerySchema.parse(request.query);
        await environmentService.remove(request.params.environmentId, request.profileId, revision);
        response.status(204).send();
    } catch (error) {
        next(error);
    }
}

export function listSecretAliases(request, response, next) {
    try {
        response.json({ data: environmentService.secretAliases(request.profileId) });
    } catch (error) {
        next(error);
    }
}
