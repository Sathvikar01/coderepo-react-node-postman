import { ProfileCookie } from "./cookie.model.js";

function liveFilter(ownerProfileId, sessionId, now) {
	return {
		ownerProfileId,
		$or: [{ expiresAt: { $gt: new Date(now) } }, { expiresAt: null, sessionId }],
	};
}

export const cookieRepository = {
	list: (ownerProfileId, sessionId, now) =>
		ProfileCookie.find(liveFilter(ownerProfileId, sessionId, now)).sort({ path: -1, createdAt: 1, name: 1 }).lean(),
	count: (ownerProfileId, sessionId, now) => ProfileCookie.countDocuments(liveFilter(ownerProfileId, sessionId, now)),
	purgeDead: (ownerProfileId, sessionId, now) =>
		ProfileCookie.deleteMany({
			ownerProfileId,
			$or: [{ expiresAt: { $lte: new Date(now) } }, { expiresAt: null, sessionId: { $ne: sessionId } }],
		}),
	upsert: (entry) =>
		ProfileCookie.findOneAndUpdate(
			{ ownerProfileId: entry.ownerProfileId, name: entry.name, domain: entry.domain, path: entry.path },
			{
				$set: {
					value: entry.value,
					hostOnly: entry.hostOnly,
					secure: entry.secure,
					httpOnly: entry.httpOnly,
					expiresAt: entry.expiresAt,
					sessionId: entry.sessionId,
				},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true },
		).lean(),
	deleteByKey: (ownerProfileId, { name, domain, path }) => ProfileCookie.deleteOne({ ownerProfileId, name, domain, path }),
	deleteById: (ownerProfileId, id) => ProfileCookie.findOneAndDelete({ _id: id, ownerProfileId }).lean(),
	clear: (ownerProfileId) => ProfileCookie.deleteMany({ ownerProfileId }),
};
