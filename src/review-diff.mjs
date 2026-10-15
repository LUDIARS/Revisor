import { classifyChange } from "./change-classification.mjs";
import { git } from "./workspace.mjs";

export async function readUnifiedDiff(cwd, mergeBase) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    mergeBase,
    "--",
  ]);
}

// -z keeps paths raw: without it Git C-quotes any path containing non-ASCII
// bytes, and the added quotes would hide a documentation extension and turn a
// docs-only change back into a blocking one.
// `git diff` reports tracked files only, so a not-yet-staged file the reviewer
// created would be invisible here while `git add --all` still commits it. The
// change profile has to see it, otherwise an autofix that adds a new code file
// keeps the change "docs-only" and the missing target domain never blocks again.
// Untracked paths are listed with the same exclusion rules the later
// `git add --all` applies, so both agree on what enters the commit.
export async function readChangedPaths(cwd, mergeBase) {
  const outputs = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  // Each output is split on its own: git() trims the trailing NUL, so joining
  // them first would glue the last tracked path onto the first untracked one.
  return [...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean)))];
}

const GITLINK_MODE = "160000";

// `--raw -z` emits `:<old mode> <new mode> <old sha> <new sha> <status>` and the
// path as separate NUL-terminated fields. The mode is the only reliable mark of
// a submodule pointer: its path looks like any extensionless source file, and
// the unified diff's `Subproject commit` body changes with `diff.submodule`.
export function parseGitlinkPaths(rawDiff) {
  const fields = String(rawDiff ?? "").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    if (!fields[index].startsWith(":")) continue;
    const [oldMode, newMode] = fields[index].slice(1).split(" ");
    if (oldMode === GITLINK_MODE || newMode === GITLINK_MODE) paths.push(fields[index + 1]);
    index += 1;
  }
  return paths;
}

export async function readGitlinkPaths(cwd, mergeBase) {
  return parseGitlinkPaths(await git(cwd, ["diff", "--raw", "-z", "--no-renames", mergeBase, "--"]));
}

export async function readChangeProfile(cwd, mergeBase) {
  const [unifiedDiff, changedPaths, gitlinkPaths] = await Promise.all([
    readUnifiedDiff(cwd, mergeBase),
    readChangedPaths(cwd, mergeBase),
    readGitlinkPaths(cwd, mergeBase),
  ]);
  return {
    unifiedDiff,
    changedPaths,
    classification: classifyChange({ changedPaths, unifiedDiff, gitlinkPaths }),
  };
}
