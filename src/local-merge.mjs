import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./config.mjs";
import { runSecurityScan } from "./security-scan.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  git,
} from "./workspace.mjs";

function commitMessage(pullRequest) {
  const body = pullRequest.body.trim();
  return [
    pullRequest.title,
    ...(body ? ["-m", body] : []),
    "-m",
    `Revisor-Local-PR: ${pullRequest.id}`,
  ];
}

// The default pre-merge scan resolves settings itself, so an injected stub
// never has to touch the on-disk Revisor configuration.
async function configuredSecurityScan({ worktreePath, diffBase, env }) {
  return runSecurityScan({ worktreePath, diffBase, settings: readSettings(env) });
}

// Runs after the squash commit exists in the integration worktree and before
// the base branch advances, so the exact bytes about to land are scanned.
async function assertMergeSecurityScan({ worktreePath, baseSha, env, scan }) {
  const security = await scan({ worktreePath, diffBase: baseSha, env }) ?? {};
  if (security.status === "findings") {
    throw new Error(
      `Merge blocked: ${security.totalFindings} security finding(s) at or above `
      + `'${security.failOnSeverity}'`
      + (security.reason ? ` (${security.reason})` : "")
      + ". Fix them and submit a new review.",
    );
  }
  if (security.status === "error") {
    throw new Error(
      `Merge blocked: the pre-merge security scan did not complete (${security.reason}).`,
    );
  }
  // Only a pass or a deliberate skip may advance the base ref. An absent or
  // unrecognised result is not a pass, and this is the last check before the
  // local base branch moves.
  if (security.status !== "passed" && security.status !== "skipped") {
    throw new Error("Merge blocked: the pre-merge security scan produced no usable result.");
  }
}

export async function squashMergeLocalPullRequest({
  repository,
  pullRequest,
  env = process.env,
  scan = configuredSecurityScan,
}) {
  if (pullRequest.status !== "open" || pullRequest.checkStatus !== "test_ok") {
    throw new Error("Only an Open / Test OK local PR can be squash merged.");
  }
  if (pullRequest.draft) throw new Error("A draft local PR cannot be merged.");
  const baseSha = await git(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${pullRequest.baseRef}`,
  ]);
  if (baseSha.toLowerCase() !== pullRequest.baseSha.toLowerCase()) {
    throw new Error("The base branch changed; submit a new review before merging.");
  }
  const headSha = await git(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${pullRequest.headRef}`,
  ]);
  if (headSha.toLowerCase() !== pullRequest.reviewedHeadSha.toLowerCase()) {
    throw new Error("The reviewed head changed; submit a new review before merging.");
  }
  const root = await mkdtemp(join(tmpdir(), "revisor-squash-merge-"));
  const worktrees = {
    root,
    head: join(root, "integration"),
    base: join(root, "unused"),
  };
  try {
    await git(repository.rootPath, ["worktree", "add", "--detach", worktrees.head, baseSha]);
    await git(worktrees.head, ["merge", "--squash", "--no-commit", headSha]);
    await git(worktrees.head, [
      "-c",
      "user.name=LUDIARS Revisor",
      "-c",
      "user.email=revisor@localhost",
      "commit",
      "-m",
      ...commitMessage(pullRequest),
    ]);
    const mergeCommitSha = await git(worktrees.head, ["rev-parse", "HEAD"]);
    await assertMergeSecurityScan({
      worktreePath: worktrees.head,
      baseSha,
      env,
      scan,
    });
    await advanceLocalBranch(
      repository.rootPath,
      pullRequest.baseRef,
      baseSha,
      mergeCommitSha,
    );
    return mergeCommitSha;
  } finally {
    await cleanupWorktrees(repository.rootPath, worktrees);
  }
}
