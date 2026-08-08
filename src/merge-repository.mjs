import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertSafeRef, git } from "./workspace.mjs";

const MERGE_REPOSITORIES_DIRECTORY = "merge-repositories";
const SOURCE_REMOTE = "revisor-source";

function repositoryDirectoryName(repository) {
  const slug = repository.repository
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "repository";
  const digest = createHash("sha256")
    .update(repository.repository.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `${slug}-${digest}`;
}

export function resolveMergeRepositoryPath({ repository, statePath }) {
  if (typeof statePath !== "string" || !statePath.trim()) {
    throw new TypeError("The Revisor state path is required for merge preparation.");
  }
  return join(
    dirname(resolve(statePath)),
    MERGE_REPOSITORIES_DIRECTORY,
    repositoryDirectoryName(repository),
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function initializeMergeRepository({
  repositoriesRoot,
  mergeRoot,
  repository,
  baseRef,
  runGit,
}) {
  const stagingRoot = await mkdtemp(join(repositoriesRoot, ".initialize-"));
  const stagedRepository = join(stagingRoot, "repository");
  try {
    // A local clone hard-links immutable object files when possible, but keeps
    // its refs, index, worktree, and future objects independent. Do not use
    // --shared: its alternates file would make this repository depend on the
    // registered checkout. Keeping the local clone fast matters because this
    // path runs before every merge.
    await runGit(repositoriesRoot, [
      "clone",
      "--no-checkout",
      "--origin",
      SOURCE_REMOTE,
      "--",
      repository.rootPath,
      stagedRepository,
    ], 300_000);
    let baseSha;
    try {
      baseSha = await runGit(stagedRepository, [
        "rev-parse",
        "--verify",
        `refs/heads/${baseRef}`,
      ]);
    } catch {
      await runGit(stagedRepository, [
        "fetch",
        "--no-tags",
        SOURCE_REMOTE,
        `+refs/heads/${baseRef}:refs/heads/${baseRef}`,
      ]);
      baseSha = await runGit(stagedRepository, [
        "rev-parse",
        "--verify",
        `refs/heads/${baseRef}`,
      ]);
    }
    // Keep no branch checked out. Branch movement can then use update-ref CAS,
    // while the persistent worktree retains Revisor's local version file.
    await runGit(stagedRepository, ["checkout", "--detach", baseSha]);
    await runGit(stagedRepository, [
      "config",
      "revisor.repository",
      repository.repository,
    ]);
    await rename(stagedRepository, mergeRoot);
  } finally {
    await rm(stagingRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}

async function assertMergeRepositoryIdentity(mergeRoot, repository, runGit) {
  const inside = await runGit(mergeRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new Error(`Revisor merge repository is invalid: ${mergeRoot}`);
  }
  const identity = await runGit(mergeRoot, ["config", "--get", "revisor.repository"]);
  if (identity.toLowerCase() !== repository.repository.toLowerCase()) {
    throw new Error(
      `Revisor merge repository identity mismatch at '${mergeRoot}'.`,
    );
  }
}

/**
 * Prepare Revisor's persistent, independent merge repository for one local PR.
 * Only Git objects are read from the registered source checkout; its worktree,
 * refs, index, branch, stash, hooks, and ignored files are never changed.
 */
export async function prepareMergeRepository({
  repository,
  pullRequest,
  statePath,
  runGit = git,
}) {
  if (!repository?.repository || !repository?.rootPath) {
    throw new TypeError("A registered repository is required for merge preparation.");
  }
  if (!pullRequest?.headRef || !pullRequest?.baseRef) {
    throw new TypeError("A local PR with head and base refs is required for merge preparation.");
  }
  assertSafeRef(pullRequest.headRef, "head_ref");
  assertSafeRef(pullRequest.baseRef, "base_ref");

  const repositoriesRoot = join(
    dirname(resolve(statePath)),
    MERGE_REPOSITORIES_DIRECTORY,
  );
  const mergeRoot = resolveMergeRepositoryPath({ repository, statePath });
  await mkdir(repositoriesRoot, { recursive: true });
  if (!await pathExists(mergeRoot)) {
    await initializeMergeRepository({
      repositoriesRoot,
      mergeRoot,
      repository,
      baseRef: pullRequest.baseRef,
      runGit,
    });
  }

  await assertMergeRepositoryIdentity(mergeRoot, repository, runGit);
  // A registration may be updated to a moved checkout. The isolated repository
  // follows that explicit registration, but no Git operation runs in the source.
  await runGit(mergeRoot, [
    "remote",
    "set-url",
    SOURCE_REMOTE,
    resolve(repository.rootPath),
  ]);
  await runGit(mergeRoot, [
    "fetch",
    "--no-tags",
    "--force",
    SOURCE_REMOTE,
    `+refs/heads/${pullRequest.headRef}:refs/heads/${pullRequest.headRef}`,
  ], 300_000);
  // The merge base is initialized once and thereafter owned by Revisor. It is
  // deliberately never refreshed from the registered checkout; publication and
  // GitHub reconciliation are the only operations allowed to advance it.
  await runGit(mergeRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${pullRequest.baseRef}`,
  ]);

  return {
    ...repository,
    registeredRootPath: repository.rootPath,
    rootPath: mergeRoot,
  };
}
