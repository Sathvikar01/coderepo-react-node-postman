import { describe, expect, test } from "bun:test";
import { filterAuthorizedProfiles } from "./profile.service.js";

const profiles = [{ _id: "a1", name: "Alex" }, { _id: "b2", name: "Jordan" }, { _id: "c3", name: "Sam" }];

describe("profile list authorization", () => {
    test("returns only the profiles the signed-in account allows", () => {
        expect(filterAuthorizedProfiles(profiles, ["b2"]).map((profile) => profile._id)).toEqual(["b2"]);
    });

    test("an account that allows no profiles sees none", () => {
        expect(filterAuthorizedProfiles(profiles, [])).toEqual([]);
    });

    test("internal calls without an account keep the unfiltered list", () => {
        expect(filterAuthorizedProfiles(profiles, undefined)).toHaveLength(3);
    });
});
