import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.mjs";

const SAFE_REF = /^(?!\/)(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+(?<!\/)$/;

function assertSafeRef(value, label) {
  if (!SAFE_REF.test(value)) throw new Error(`${label} is not a safe Git ref`);
}

export async function git(cwd, args, timeoutMs = 120_000) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs });
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

function parseWorktreeList(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => Object.fromEntries(
      block.split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1
            ? [line, true]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
    ))
    .filter((record) => typeof record.worktree === "string");
}

// Only tracked changes count as dirty, for both callers. A review reads a fixed
// SHA in a disposable worktree, so an untracked scratch file can never reach it;
// and a fast-forward ignores untracked files that do not collide, while Git
// itself aborts one that would overwrite them.
// A submodule's own uncommitted content belongs to that submodule, not to this
// PR: the parent still records the same commit, so neither the review nor the
// fast-forward is affected. A changed submodule *pointer* is a tracked change
// and is still reported.
async function trackedChanges(worktreePath) {
  return git(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--ignore-submodules=dirty",
  ]);
}

async function branchWorktree(repoPath, ref) {
  const branch = `refs/heads/${ref}`;
  const records = parseWorktreeList(await git(repoPath, ["worktree", "list", "--porcelain"]));
  return records.find((record) => record.branch === branch)?.worktree ?? null;
}

export async function inspectLocalPullRequest(repoPath, headRef, baseRef) {
  assertSafeRef(headRef, "head_ref");
  assertSafeRef(baseRef, "base_ref");
  if (headRef === baseRef) throw new Error("head_ref and base_ref must differ.");
  const headSha = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${headRef}`]);
  const baseSha = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]);
  if (headSha === baseSha) throw new Error("The local PR has no commits to review.");
  const checkedOutAt = await branchWorktree(repoPath, headRef);
  if (checkedOutAt) {
    const status = await trackedChanges(checkedOutAt);
    if (status) {
      throw new Error(
        `The head branch worktree has uncommitted changes: ${checkedOutAt}`,
      );
    }
  }
  return {
    headSha,
    baseSha,
    mergeBase: await git(repoPath, ["merge-base", headSha, baseSha]),
  };
}

export async function prepareLocalWorktrees(repoPath, request) {
  const inspected = await inspectLocalPullRequest(
    repoPath,
    request.headRef,
    request.baseRef,
  );
  if (inspected.headSha.toLowerCase() !== request.headSha.toLowerCase()) {
    throw new Error(
      `head SHA changed before review (expected ${request.headSha}, found ${inspected.headSha})`,
    );
  }
  if (
    request.baseSha
    && inspected.baseSha.toLowerCase() !== request.baseSha.toLowerCase()
  ) {
    throw new Error(
      `base SHA changed before review (expected ${request.baseSha}, found ${inspected.baseSha})`,
    );
  }
  const root = await mkdtemp(join(tmpdir(), "revisor-local-pr-"));
  const worktrees = {
    root,
    head: join(root, "head"),
    base: join(root, "base"),
    mergeBase: inspected.mergeBase,
  };
  try {
    await git(repoPath, ["worktree", "add", "--detach", worktrees.head, inspected.headSha]);
    await git(repoPath, ["worktree", "add", "--detach", worktrees.base, inspected.mergeBase]);
    return worktrees;
  } catch (error) {
    await cleanupWorktrees(repoPath, worktrees);
    throw error;
  }
}

export async function advanceLocalBranch(repoPath, ref, expectedSha, nextSha) {
  assertSafeRef(ref, "branch");
  const current = await git(repoPath, ["rev-parse", "--verify", `refs/heads/${ref}`]);
  if (current.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`Local branch '${ref}' changed while Revisor was working.`);
  }
  if (current.toLowerCase() === nextSha.toLowerCase()) return nextSha;
  const checkedOutAt = await branchWorktree(repoPath, ref);
  if (!checkedOutAt) {
    await git(repoPath, [
      "update-ref",
      `refs/heads/${ref}`,
      nextSha,
      expectedSha,
    ]);
    return nextSha;
  }
  const status = await trackedChanges(checkedOutAt);
  if (status) {
    throw new Error(`Cannot advance '${ref}'; its worktree is no longer clean.`);
  }
  await git(checkedOutAt, ["merge", "--ff-only", nextSha]);
  return nextSha;
}

export async function cleanupWorktrees(repoPath, worktrees) {
  for (const path of [worktrees.head, worktrees.base]) {
    try {
      await git(repoPath, ["worktree", "remove", "--force", path]);
    } catch {
      // Partial setup may not have registered both disposable worktrees.
    }
  }
  try {
    await git(repoPath, ["worktree", "prune"]);
  } catch {
    // Cleanup is best-effort after individual worktree removal attempts.
  }
  await rm(worktrees.root, { recursive: true, force: true });
}
