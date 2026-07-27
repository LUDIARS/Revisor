import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function squashMergeLocalPullRequest({
  repository,
  pullRequest,
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
