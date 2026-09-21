import { z } from "zod";
import { cookieService } from "./cookie.service.js";

const cookieIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Provide a valid cookie identifier.");

export async function listCookies(request, response, next) {
	try {
		response.json({ data: await cookieService.list(request.profileId) });
	} catch (error) {
		next(error);
	}
}

export async function deleteCookie(request, response, next) {
	try {
		await cookieService.remove(request.profileId, cookieIdSchema.parse(request.params.cookieId));
		response.status(204).send();
	} catch (error) {
		next(error);
	}
}

export async function clearCookies(request, response, next) {
	try {
		await cookieService.clear(request.profileId);
		response.status(204).send();
	} catch (error) {
		next(error);
	}
}
