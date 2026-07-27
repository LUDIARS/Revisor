import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorkspaceRoot } from "./catalog.mjs";
import { runProcess } from "./process.mjs";

const SAFE_REF = /^(?!\/)(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+(?<!\/)$/;

function originSlug(raw) {
  const normalized = raw.trim().replace(/\\/g, "/").replace(/\.git$/, "");
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(normalized);
  if (https) return https[1];
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+)$/i.exec(normalized);
  return ssh?.[1] ?? null;
}

function assertSafeRef(value, label) {
  if (!SAFE_REF.test(value)) throw new Error(`${label} is not a safe Git ref`);
}

export async function resolveRepositoryPath(cwd, repository) {
  const [, repositoryName] = repository.split("/");
  if (!repositoryName) throw new Error(`Invalid repository '${repository}'.`);
  const path = resolve(resolveWorkspaceRoot(cwd), repositoryName);
  await access(path);
  return path;
}

export async function git(cwd, args, timeoutMs = 120_000) {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs });
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

export async function prepareWorktrees(repoPath, request) {
  assertSafeRef(request.headRef, "head_ref");
  assertSafeRef(request.baseRef, "base_ref");
  const remote = originSlug(await git(repoPath, ["config", "--get", "remote.origin.url"]));
  if (remote?.toLowerCase() !== request.repository.toLowerCase()) {
    throw new Error(`Local origin '${remote ?? "unknown"}' does not match '${request.repository}'`);
  }
  await git(repoPath, [
    "fetch",
    "origin",
    `+refs/heads/${request.headRef}:refs/remotes/origin/${request.headRef}`,
    `+refs/heads/${request.baseRef}:refs/remotes/origin/${request.baseRef}`,
  ]);
  const fetchedHead = await git(repoPath, ["rev-parse", `refs/remotes/origin/${request.headRef}`]);
  if (fetchedHead.toLowerCase() !== request.headSha.toLowerCase()) {
    throw new Error(`head SHA changed before review (expected ${request.headSha}, found ${fetchedHead})`);
  }
  const mergeBase = await git(repoPath, [
    "merge-base",
    fetchedHead,
    `refs/remotes/origin/${request.baseRef}`,
  ]);
  const root = await mkdtemp(join(tmpdir(), "revisor-pr-review-"));
  const worktrees = {
    root,
    head: join(root, "head"),
    base: join(root, "base"),
    mergeBase,
  };
  try {
    await git(repoPath, ["worktree", "add", "--detach", worktrees.head, fetchedHead]);
    await git(repoPath, ["worktree", "add", "--detach", worktrees.base, mergeBase]);
    return worktrees;
  } catch (error) {
    await cleanupWorktrees(repoPath, worktrees);
    throw error;
  }
}

export async function cleanupWorktrees(repoPath, worktrees) {
  for (const path of [worktrees.head, worktrees.base]) {
    try {
      await git(repoPath, ["worktree", "remove", "--force", path]);
    } catch {
      // Partial setup may not have registered both disposable worktrees.
    }
  }
  await rm(worktrees.root, { recursive: true, force: true });
}
