// Bounded filesystem I/O for the git-native project layout.
//
// This is the ONLY module in the git-native feature that touches disk, and it
// is deliberately narrow. Every path is validated as a safe relative path and
// then re-checked to resolve inside the project root before any read or write,
// so project content can never reach a file outside its own project boundary.
// No Git command is ever spawned: a project is just a directory of text files
// that the user versions with their own Git tooling.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "../../shared/errors/app-error.js";
import { assertSafeRelPath } from "./project-text.js";

function resolveWithin(root, rel, label) {
	const safe = assertSafeRelPath(rel, label);
	const base = path.resolve(root);
	const target = path.resolve(base, safe);
	const relToRoot = path.relative(base, target);
	if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot))
		throw new AppError(400, "PROJECT_UNSAFE_PATH", `A ${label} must resolve inside the project root.`, { label });
	return target;
}

function walk(root, dir, out) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(root, full, out);
		} else if (entry.isFile()) {
			const rel = path.relative(root, full).split(path.sep).join("/");
			// Skip dotfiles/tooling noise (e.g. .gitignore); they are not project data.
			if (rel.split("/").some((segment) => segment.startsWith("."))) continue;
			out.push(rel);
		}
	}
}

// Read a project directory into a Map of safe relative paths to text.
export function readProjectDir(root) {
	const base = path.resolve(root);
	if (!existsSync(base) || !statSync(base).isDirectory())
		throw new AppError(400, "PROJECT_MISSING_FILE", "The project directory does not exist.", { label: "project root" });
	const rels = [];
	walk(base, base, rels);
	const files = new Map();
	for (const rel of rels.sort()) {
		assertSafeRelPath(rel, "project file name");
		files.set(rel, readFileSync(resolveWithin(base, rel, "project file name"), "utf8"));
	}
	return files;
}

// Write a Map of safe relative paths to text into a project directory. The
// target directory is cleared first so the on-disk tree exactly matches the
// exported files (deterministic export; renames leave no stale files). The
// clear is bounded to the resolved project root.
export function writeProjectDir(root, files) {
	const base = path.resolve(root);
	for (const rel of files.keys()) resolveWithin(base, rel, "project file name");
	if (existsSync(base)) rmSync(base, { recursive: true, force: true });
	mkdirSync(base, { recursive: true });
	for (const [rel, text] of files) {
		const target = resolveWithin(base, rel, "project file name");
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, String(text ?? ""), "utf8");
	}
	return [...files.keys()].sort();
}
