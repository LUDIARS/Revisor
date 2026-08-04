import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./config.mjs";
import { MergeConflictError, StaleReviewError } from "./errors.mjs";
import { runSecurityScan } from "./security-scan.mjs";
import { findTaggedMerge } from "./git-publication.mjs";
import { assertLocalVersionUnchanged } from "./local-version.mjs";
import { publishMergedPullRequest } from "./release-publisher.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  diffPatchId,
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

// 審査済みヘッドと現在ヘッドの「merge-base からの差分内容」を patch-id で比較する。
// 一致すれば審査結果は現在ヘッドにそのまま適用できる。 審査済み SHA が既に GC
// されている等で比較できない場合も、未知の内容をマージしない側に倒す。
async function assertReviewedContentUnchanged(rootPath, reviewedHeadSha, headSha, baseSha) {
  let unchanged = false;
  try {
    const [reviewedPatchId, currentPatchId] = await Promise.all([
      diffPatchId(rootPath, reviewedHeadSha, baseSha),
      diffPatchId(rootPath, headSha, baseSha),
    ]);
    unchanged = reviewedPatchId === currentPatchId;
  } catch (error) {
    throw new StaleReviewError(
      "The reviewed head is gone and the current head cannot be compared to it; a new review is required.",
      { cause: error },
    );
  }
  if (!unchanged) {
    throw new StaleReviewError(
      "The head content changed after the review; a new review is required.",
    );
  }
}

// コンフリクト判定をエラーメッセージだけに頼らない。 `git()` のメッセージは stderr を
// 優先するので、 Windows の autocrlf 警告のような無関係な stderr が 1 行でも出ると
// "CONFLICT" が message から消え、 コンフリクトが「不明な失敗」に化ける (PR は Test OK
// のまま残り、 スイープが 60 秒ごとに同じ失敗を繰り返す)。 `merge --squash --no-commit`
// のコンフリクトは index に unmerged entry を残すので、それを一次情報として見る。
async function isMergeConflict(worktreePath, message) {
  if (/CONFLICT|Automatic merge failed|not something we can merge/i.test(message)) return true;
  try {
    return Boolean(await git(worktreePath, ["ls-files", "--unmerged"]));
  } catch {
    // index を読めないなら判定材料が無い。 コンフリクト扱いにはしない。
    return false;
  }
}

export async function squashMergeLocalPullRequest({
  repository,
  pullRequest,
  env = process.env,
  scan = configuredSecurityScan,
  publish = publishMergedPullRequest,
}) {
  if (pullRequest.status !== "open" || pullRequest.checkStatus !== "test_ok") {
    throw new Error("Only an Open / Test OK local PR can be squash merged.");
  }
  if (pullRequest.draft) throw new Error("A draft local PR cannot be merged.");
  // ベースは審査時の SHA に固定しない。 他 PR のマージで base は常に前進するので、
  // 固定すると 1 本マージするたびに残り全部がマージ不能になる。 進んだ base とは
  // squash 適用時のコンフリクトだけを判定に使う。
  const baseSha = await git(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${pullRequest.baseRef}`,
  ]);
  const headSha = await git(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${pullRequest.headRef}`,
  ]);
  await assertLocalVersionUnchanged(repository.rootPath, baseSha, headSha);
  if (headSha.toLowerCase() !== pullRequest.reviewedHeadSha.toLowerCase()) {
    // rebase で SHA だけ変わったヘッドは審査結果を引き継ぐ。差分内容が審査時と
    // 変わっていたら、それは未審査のコードなので再審査へ。
    await assertReviewedContentUnchanged(
      repository.rootPath,
      pullRequest.reviewedHeadSha,
      headSha,
      baseSha,
    );
  }
  // A process can stop after the atomic GitHub push or Release creation and
  // before local state is marked merged. The annotated version tag keeps that
  // prepared commit reachable, so retry completes publication instead of
  // generating a second squash commit for the same reviewed PR.
  const prepared = await findTaggedMerge(repository.rootPath, pullRequest.id);
  if (prepared) {
    const expectedBaseSha = await git(repository.rootPath, [
      "rev-parse",
      `${prepared.mergeCommitSha}^`,
    ]);
    const publication = await publish({
      repository,
      pullRequest,
      expectedBaseSha,
      mergeCommitSha: prepared.mergeCommitSha,
      preparedTag: prepared.tag,
      env,
    });
    await advanceLocalBranch(
      repository.rootPath,
      pullRequest.baseRef,
      baseSha,
      prepared.mergeCommitSha,
    );
    return publication;
  }
  const root = await mkdtemp(join(tmpdir(), "revisor-squash-merge-"));
  const worktrees = {
    root,
    head: join(root, "integration"),
    base: join(root, "unused"),
  };
  try {
    await git(repository.rootPath, ["worktree", "add", "--detach", worktrees.head, baseSha]);
    try {
      await git(worktrees.head, ["merge", "--squash", "--no-commit", headSha]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (await isMergeConflict(worktrees.head, message)) {
        throw new MergeConflictError(
          `The head conflicts with the current '${pullRequest.baseRef}'; rebase the branch and submit a new review.`,
          { cause: error },
        );
      }
      throw error;
    }
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
    const publication = await publish({
      repository,
      pullRequest,
      expectedBaseSha: baseSha,
      mergeCommitSha,
      env,
    });
    await advanceLocalBranch(
      repository.rootPath,
      pullRequest.baseRef,
      baseSha,
      mergeCommitSha,
    );
    return publication;
  } finally {
    await cleanupWorktrees(repository.rootPath, worktrees);
  }
}
