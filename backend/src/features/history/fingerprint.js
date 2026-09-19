import crypto from "node:crypto";
import { getConfig } from "../../shared/config/index.js";

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const output = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) continue;
            output[key] = canonicalize(value[key]);
        }
        return output;
    }
    return value;
}

export function fingerprintOf(input) {
    const canonical = JSON.stringify(canonicalize({ schemaVersion: 1, ...input }));
    return crypto.createHmac("sha256", getConfig().fingerprintKey).update(canonical).digest("hex");
}

export function fingerprintKeyId() {
    return getConfig().fingerprintKeyId;
}
