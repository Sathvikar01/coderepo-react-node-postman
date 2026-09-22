// Deterministic, human-readable line diffs for git-native project files.
//
// This is the "meaningful diff" half of the git-native workflow. Because the
// layout writes pretty, key-sorted JSON with one field per line, a small
// request edit is a small line diff. This module renders that diff in familiar
// unified format so reviewers see exactly what changed and why.
//
// Deliberately NOT `git diff`. The requirement is that project content must
// never be able to run a command. Diffing two strings in-process is total and
// safe: no shell, no injection surface, no repository dependency. Real
// `git diff` still works on the exported tree (that is the point of the stable
// layout); this is the same view for tooling and tests without spawning Git.

const CONTEXT = 3;
const MAX_DP_CELLS = 4_000_000;

function splitLines(text) {
	if (text === undefined || text === null) return [];
	const normalized = String(text).replace(/\r\n/g, "\n");
	if (normalized === "") return [];
	const lines = normalized.split("\n");
	// A trailing newline yields a phantom empty last element; drop it so the
	// rendered line count matches what a reviewer sees.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

// Longest-common-subsequence edit script over lines: returns ops in order.
function lcsOps(a, b) {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let aEnd = a.length;
	let bEnd = b.length;
	while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
		aEnd--;
		bEnd--;
	}

	const ops = [];
	for (let i = 0; i < start; i++) ops.push({ type: "same", line: a[i] });

	const aMid = a.slice(start, aEnd);
	const bMid = b.slice(start, bEnd);
	if (aMid.length * bMid.length > MAX_DP_CELLS) {
		for (const line of aMid) ops.push({ type: "del", line });
		for (const line of bMid) ops.push({ type: "add", line });
	} else {
		const n = aMid.length;
		const m = bMid.length;
		const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = aMid[i] === bMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (aMid[i] === bMid[j]) {
				ops.push({ type: "same", line: aMid[i] });
				i++;
				j++;
			} else if (dp[i + 1][j] >= dp[i][j + 1]) {
				ops.push({ type: "del", line: aMid[i] });
				i++;
			} else {
				ops.push({ type: "add", line: bMid[j] });
				j++;
			}
		}
		while (i < n) ops.push({ type: "del", line: aMid[i++] });
		while (j < m) ops.push({ type: "add", line: bMid[j++] });
	}

	for (let i = aEnd; i < a.length; i++) ops.push({ type: "same", line: a[i] });
	return ops;
}

// Group changed regions into hunks, each padded with up to CONTEXT lines of
// surrounding context and merging changes that sit close together.
function hunksFromOps(ops) {
	const changed = ops.map((op) => op.type !== "same");
	const hunks = [];
	let i = 0;
	while (i < ops.length) {
		if (!changed[i]) {
			i++;
			continue;
		}
		let last = i;
		let j = i;
		while (j < ops.length) {
			if (changed[j]) last = j;
			else if (j - last > CONTEXT * 2) break;
			j++;
		}
		const lo = Math.max(0, i - CONTEXT);
		const hi = Math.min(ops.length - 1, last + CONTEXT);
		hunks.push({ lo, hi });
		i = hi + 1;
	}
	return hunks;
}

function formatFileDiff(beforeText, afterText, beforeLabel, afterLabel) {
	if (beforeText === afterText) return "";
	const a = splitLines(beforeText);
	const b = splitLines(afterText);
	const ops = lcsOps(a, b);
	const hunks = hunksFromOps(ops);
	if (hunks.length === 0) return "";

	const out = [];
	out.push(`--- ${beforeLabel}`);
	out.push(`+++ ${afterLabel}`);

	// Walk ops once, tracking 1-based pre/post line numbers per hunk.
	let aLine = 1;
	let bLine = 1;
	let opIndex = 0;
	for (const hunk of hunks) {
		while (opIndex < hunk.lo) {
			const t = ops[opIndex].type;
			if (t === "same") {
				aLine++;
				bLine++;
			} else if (t === "del") {
				aLine++;
			} else {
				bLine++;
			}
			opIndex++;
		}
		const aStart = aLine;
		const bStart = bLine;
		const body = [];
		let aCount = 0;
		let bCount = 0;
		while (opIndex <= hunk.hi) {
			const op = ops[opIndex];
			if (op.type === "same") {
				body.push(` ${op.line}`);
				aCount++;
				bCount++;
				aLine++;
				bLine++;
			} else if (op.type === "del") {
				body.push(`-${op.line}`);
				aCount++;
				aLine++;
			} else {
				body.push(`+${op.line}`);
				bCount++;
				bLine++;
			}
			opIndex++;
		}
		out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
		out.push(...body);
	}
	return `${out.join("\n")}\n`;
}

// Unified diff for a single file. `undefined` before/after means absent.
export function diffText(beforeText, afterText, path = "file") {
	if (beforeText === afterText) return "";
	const beforeLabel = beforeText === undefined ? "/dev/null" : `a/${path}`;
	const afterLabel = afterText === undefined ? "/dev/null" : `b/${path}`;
	return formatFileDiff(beforeText, afterText, beforeLabel, afterLabel);
}

// A request file's name may change while its stable id (and therefore the
// `--<id8>` filename suffix) survives. That is a rename, not a delete + add:
// detect it so the diff stays small and reviewable instead of restating the
// whole file. Returns a suffix -> path map for id-bearing files.
function suffixIndex(paths) {
	const index = new Map();
	for (const path of paths) {
		const match = /--([a-f0-9]{8})\.json$/.exec(path);
		if (match) index.set(match[1], path);
	}
	return index;
}

// Combined diff over two project file trees. Added, removed, changed, and
// renamed files are reported; unchanged files are omitted. Paths are visited in
// sorted order so the output is deterministic.
export function diffProjectFiles(before, after) {
	const beforeMap = before instanceof Map ? before : new Map(Object.entries(before ?? {}));
	const afterMap = after instanceof Map ? after : new Map(Object.entries(after ?? {}));

	const beforeOnly = [...beforeMap.keys()].filter((p) => !afterMap.has(p)).sort();
	const afterOnly = [...afterMap.keys()].filter((p) => !beforeMap.has(p)).sort();

	// Pair renamed request files by their shared id suffix.
	const beforeSuf = suffixIndex(beforeOnly);
	const afterSuf = suffixIndex(afterOnly);
	const renames = [];
	for (const [suffix, oldPath] of beforeSuf) {
		const newPath = afterSuf.get(suffix);
		if (newPath) renames.push({ oldPath, newPath });
	}
	const renamedOld = new Set(renames.map((r) => r.oldPath));
	const renamedNew = new Set(renames.map((r) => r.newPath));

	const both = [...beforeMap.keys()].filter((p) => afterMap.has(p)).sort();

	let combined = "";
	for (const path of both) {
		const beforeText = beforeMap.get(path);
		const afterText = afterMap.get(path);
		if (beforeText === afterText) continue;
		combined += formatFileDiff(beforeText, afterText, `a/${path}`, `b/${path}`);
	}
	for (const { oldPath, newPath } of renames) {
		combined += formatFileDiff(beforeMap.get(oldPath), afterMap.get(newPath), `a/${oldPath}`, `b/${newPath}`);
	}
	for (const path of beforeOnly) {
		if (renamedOld.has(path)) continue;
		combined += formatFileDiff(beforeMap.get(path), undefined, `a/${path}`, "/dev/null");
	}
	for (const path of afterOnly) {
		if (renamedNew.has(path)) continue;
		combined += formatFileDiff(undefined, afterMap.get(path), "/dev/null", `b/${path}`);
	}
	return combined;
}

// Count of changed lines (+ and -) in a diff string, for asserting that a diff
// is "small".
export function diffChangeCount(diff) {
	let count = 0;
	for (const line of String(diff ?? "").split("\n")) {
		if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) count++;
	}
	return count;
}
