import { describe, expect, test } from "bun:test";
import { classifyResourceEvent, isOwnSessionEvent, RESOURCE_EVENT } from "./event-reconciliation.js";

const ORIGIN = "session-11111111";
const OTHER_SESSION = "session-22222222";

function collectionEvent(overrides = {}) {
	return {
		id: "ws-1:7",
		action: "collection.updated",
		resourceType: "collection",
		resourceId: "col-1",
		revision: 4,
		actorProfileId: "profile-1",
		originClientId: ORIGIN,
		...overrides,
	};
}

describe("workspace event origin identity", () => {
	test("recognises only the exact session origin, never the whole profile", () => {
		expect(isOwnSessionEvent(collectionEvent(), ORIGIN)).toBe(true);
		// Another browser session sharing the same profile must not be mistaken for
		// this one: it has a different origin.
		expect(isOwnSessionEvent(collectionEvent(), OTHER_SESSION)).toBe(false);
		// An event with no origin (CLI, seed, legacy server) is never a self-echo.
		expect(isOwnSessionEvent(collectionEvent({ originClientId: null }), ORIGIN)).toBe(false);
	});

	test("treats this session's own event as self even while the draft is dirty", () => {
		const decision = classifyResourceEvent(collectionEvent(), { clientOrigin: ORIGIN, dirty: true });
		expect(decision).toBe(RESOURCE_EVENT.SELF);
	});

	test("raises the conflict notice only for a different session writing to a dirty draft", () => {
		const event = collectionEvent({ originClientId: OTHER_SESSION });
		expect(classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: true })).toBe(RESOURCE_EVENT.NOTICE);
		expect(classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: false })).toBe(RESOURCE_EVENT.APPLY);
	});

	test("treats an origin-less remote event as a collaborator change", () => {
		const event = collectionEvent({ originClientId: null });
		expect(classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: true })).toBe(RESOURCE_EVENT.NOTICE);
		expect(classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: false })).toBe(RESOURCE_EVENT.APPLY);
	});
});

// The two orderings the race can occur in. Both must leave the same local state
// and neither may raise a stale banner for this session's own save.
describe("event/response ordering", () => {
	const runOrdering = (order) => {
		// Local model: a dirty draft based on revision 3, saved to revision 4.
		let tab = { collectionId: "col-1", revision: 3, dirty: true };
		const notices = [];
		const event = collectionEvent({ revision: 4 });

		const handleEvent = () => {
			const decision = classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: tab.dirty });
			if (decision === RESOURCE_EVENT.NOTICE) notices.push(event.revision);
			if (decision === RESOURCE_EVENT.APPLY) tab = { ...tab, revision: event.revision, dirty: false };
			// SELF and IGNORE change nothing: the local mutation response owns it.
		};
		const handleResponse = () => {
			tab = { ...tab, revision: 4, dirty: false };
		};

		if (order === "event-first") {
			handleEvent();
			handleResponse();
		} else {
			handleResponse();
			handleEvent();
		}
		return { tab, notices };
	};

	test("event arrives before the save response", () => {
		const { tab, notices } = runOrdering("event-first");
		expect(notices).toEqual([]);
		expect(tab).toEqual({ collectionId: "col-1", revision: 4, dirty: false });
	});

	test("save response arrives before the event", () => {
		const { tab, notices } = runOrdering("response-first");
		expect(notices).toEqual([]);
		expect(tab).toEqual({ collectionId: "col-1", revision: 4, dirty: false });
	});

	test("a genuine collaborator save still raises the banner and preserves the draft", () => {
		const event = collectionEvent({ originClientId: OTHER_SESSION, revision: 9, actorName: "Jordan" });
		const decision = classifyResourceEvent(event, { clientOrigin: ORIGIN, dirty: true });
		expect(decision).toBe(RESOURCE_EVENT.NOTICE);
	});
});
