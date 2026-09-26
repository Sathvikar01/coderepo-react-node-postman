import { parseCurl } from "./curl-parser.js";
import { generateSnippet } from "./snippets.js";

export const requestToolsService = {
	parseCurl(text) {
		return parseCurl(text);
	},
	generateSnippet(request, format, collectionAuth = null) {
		return generateSnippet(request, format, { collectionAuth });
	},
};
