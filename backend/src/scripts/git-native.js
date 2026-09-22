// Git-native TracerProjectV1 CLI: a bounded, dependency-free way to move a
// project between the canonical portable JSON and a deterministic multi-file
// directory that is pleasant to version, diff, and review in Git.
//
// This tool NEVER executes Git. It only reads and writes bounded project files
// so there is no command injection and no shell. Project data controls neither
// commands nor filesystem paths outside the target directory; every path is
// confined by the git-native filesystem layer.
//
//   bun src/scripts/git-native.js export <portable.json> <dir>
//       Split a canonical TracerProjectV1 JSON file into the git-native layout.
//
//   bun src/scripts/git-native.js validate <dir>
//       Fail closed on malformed / version-incompatible / unknown / conflicting
//       files. Prints the project fingerprint when the directory is valid.
//
//   bun src/scripts/git-native.js import <dir> <portable.json>
//       Validate the directory and reassemble one canonical portable JSON file
//       ready to feed back into Tracer.
//
//   bun src/scripts/git-native.js diff <dirA> <dirB>
//       Print a deterministic unified diff of two project directories.
//
//   bun src/scripts/git-native.js fingerprint <dir>
//       Print the canonical project fingerprint and per-file content hashes.

import { readFileSync, writeFileSync } from "node:fs";

import { parseProject, serializeProject, projectFingerprint } from "../features/projects/project-serialize.js";
import { projectToFiles, filesToProject } from "../features/git-native/project-layout.js";
import { readProjectDir, writeProjectDir } from "../features/git-native/project-fs.js";
import { diffProjectFiles, diffChangeCount } from "../features/git-native/project-diff.js";
import { sha256Hex } from "../features/git-native/project-text.js";

const USAGE = `usage: git-native <export|validate|import|diff|fingerprint> [args]

  export      <portable.json> <dir>   split a portable project into files
  validate    <dir>                  validate a project directory (fail closed)
  import      <dir> <portable.json>   reassemble a portable project from files
  diff        <dirA> <dirB>           unified diff of two project directories
  fingerprint <dir>                   print the project and per-file hashes

This tool never runs Git and never shells out.`;

function fail(message, code = 2) {
	console.error(`git-native: ${message}`);
	return code;
}

// Run the CLI over an argv array (without the leading node/script pair). Pure
// file I/O: returns a numeric exit code and never throws for user errors.
export function runGitNative(argv) {
	const [command, ...rest] = argv;

	try {
		switch (command) {
			case "export": {
				const [source, dir] = rest;
				if (!source || !dir) return fail(USAGE);
				const project = parseProject(readFileSync(source, "utf8"));
				writeProjectDir(dir, projectToFiles(project));
				console.log(`wrote ${dir}`);
				return 0;
			}
			case "validate": {
				const [dir] = rest;
				if (!dir) return fail(USAGE);
				const files = readProjectDir(dir);
				const project = filesToProject(files);
				console.log(`valid tracer project`);
				console.log(`fingerprint: ${projectFingerprint(project)}`);
				return 0;
			}
			case "import": {
				const [dir, target] = rest;
				if (!dir || !target) return fail(USAGE);
				const project = filesToProject(readProjectDir(dir));
				writeFileSync(target, serializeProject(project), "utf8");
				console.log(`wrote ${target}`);
				return 0;
			}
			case "diff": {
				const [dirA, dirB] = rest;
				if (!dirA || !dirB) return fail(USAGE);
				const diff = diffProjectFiles(readProjectDir(dirA), readProjectDir(dirB));
				process.stdout.write(diff);
				console.error(`${diffChangeCount(diff)} changed lines`);
				return 0;
			}
			case "fingerprint": {
				const [dir] = rest;
				if (!dir) return fail(USAGE);
				const files = readProjectDir(dir);
				const project = filesToProject(files);
				console.log(`fingerprint: ${projectFingerprint(project)}`);
				for (const rel of [...files.keys()].sort()) {
					console.log(`  ${sha256Hex(files.get(rel))}  ${rel}`);
				}
				return 0;
			}
			case "help":
			case undefined:
				console.log(USAGE);
				return command === "help" ? 0 : 2;
			default:
				return fail(`unknown command "${command}"\n${USAGE}`);
		}
	} catch (error) {
		const code = typeof error?.code === "string" ? error.code : "PROJECT_INVALID";
		console.error(`git-native: ${code}: ${error?.message ?? error}`);
		return 1;
	}
}

export function resolveTargetDir(dir) {
	return path.resolve(dir);
}

if (import.meta.main) {
	process.exit(runGitNative(process.argv.slice(2)));
}
