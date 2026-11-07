/**
 * @implements RV-NATIVE-DEPS-01 — read a repository tree either as the review
 * worktree (the PR's head, untracked new files included) or as a commit (the
 * merge base), through one interface so the inventory is built the same way.
 *
 * SRP: listing files, reading text and listing gitlinks of one tree.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../process.mjs";

const MAX_LISTING = 30_000;

async function git(root, args, run) {
  const result = await run({ command: "git", args, cwd: root, timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function lines(text, separator = "\0") {
  const entries = text.split(separator).filter(Boolean);
  if (entries.length > MAX_LISTING) throw new Error("file count limit");
  return entries;
}

/**
 * The review worktree: tracked plus nonignored new files, as the PR will land.
 * @implements RV-NATIVE-DEPS-01
 */
export function worktreeSource(root, { run = runProcess } = {}) {
  return {
    async files() {
      return lines(await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], run));
    },
    async read(path) {
      return readFile(join(root, path), "utf8");
    },
    async gitlinks() {
      const links = new Map();
      for (const entry of lines(await git(root, ["ls-files", "--stage", "-z"], run))) {
        const match = /^160000 ([0-9a-f]{40}) \d\t(.+)$/.exec(entry);
        if (match) links.set(match[2], match[1]);
      }
      return links;
    },
  };
}

/**
 * A commit (the merge base): what the dependencies were before the PR.
 * @implements RV-NATIVE-DEPS-01
 */
export function commitSource(root, ref, { run = runProcess } = {}) {
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new Error("commit ref required");
  return {
    async files() {
      return lines(await git(root, ["ls-tree", "-r", "-z", "--name-only", ref], run));
    },
    async read(path) {
      return git(root, ["show", `${ref}:${path}`], run);
    },
    async gitlinks() {
      const links = new Map();
      for (const entry of lines(await git(root, ["ls-tree", "-r", "-z", ref], run))) {
        const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(entry);
        if (match) links.set(match[2], match[1]);
      }
      return links;
    },
  };
}
