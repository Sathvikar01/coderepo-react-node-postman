import net from "node:net";
import { AppError } from "../../shared/errors/app-error.js";
import { classifyLocalAddress, isMetadataHostname } from "./local-address-policy.js";

// Invoked by the target policy only after the user enabled Local Runtime for
// this profile and the request host exactly matches an approved entry. Every
// resolved address must stay inside the local ranges, so mixed DNS answers,
// rebinding, and metadata endpoints cannot slip through. The chosen address is
// returned as the pinned transport address; the transport dials that literal
// and re-verifies the connected peer, so a later DNS change has no effect.
export async function validateLocalTarget({ resolver, hostname, port, url, isIpLiteral, policyVersion }) {
	if (isMetadataHostname(hostname))
		throw new AppError(400, "TARGET_BLOCKED", "Cloud metadata endpoints are never available to Local Runtime.");
	const candidates = isIpLiteral ? [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }] : await resolver.resolve(hostname);
	const unique = new Map();
	for (const candidate of candidates ?? []) {
		if (!candidate?.address) continue;
		unique.set(candidate.address, candidate);
	}
	if (unique.size === 0) throw new AppError(502, "TARGET_UNRESOLVED", "The approved local hostname could not be resolved.");
	for (const candidate of unique.values()) {
		const classification = classifyLocalAddress(candidate.address);
		if (classification.metadata)
			throw new AppError(400, "TARGET_BLOCKED", "The approved host resolves to a cloud metadata endpoint.", {
				address: candidate.address,
			});
		if (!classification.permitted)
			throw new AppError(
				400,
				"TARGET_BLOCKED",
				"The approved host resolves to an address outside the local ranges permitted by Local Runtime.",
				{ address: candidate.address },
			);
	}
	const chosen = [...unique.values()][0];
	return {
		scheme: url.protocol.slice(0, -1),
		originalHostname: hostname,
		authority: url.host,
		port,
		pathAndQuery: `${url.pathname}${url.search}`,
		ip: chosen.address,
		family: chosen.family === 6 ? 6 : 4,
		isIpLiteral,
		policyVersion,
		local: true,
	};
}
