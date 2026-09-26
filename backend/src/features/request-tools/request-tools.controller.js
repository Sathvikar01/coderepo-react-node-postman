import { z } from "zod";
import { authSchema } from "../../shared/utils/schemas.js";
import { requestToolsService } from "./request-tools.service.js";

const parseCurlSchema = z.object({ text: z.string().max(64 * 1024) }).strict();
const snippetSchema = z
	.object({
		request: z.record(z.string(), z.unknown()),
		format: z.enum(["curl", "javascript", "node", "python"]),
		collectionAuth: authSchema.nullable().optional(),
	})
	.strict();

export async function parseCurlImport(request, response, next) {
	try {
		const { text } = parseCurlSchema.parse(request.body);
		response.json({ data: requestToolsService.parseCurl(text) });
	} catch (error) {
		next(error);
	}
}

export async function generateCodeSnippet(request, response, next) {
	try {
		const input = snippetSchema.parse(request.body);
		response.json({
			data: requestToolsService.generateSnippet(input.request, input.format, input.collectionAuth ?? null),
		});
	} catch (error) {
		next(error);
	}
}
