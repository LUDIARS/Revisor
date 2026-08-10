import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./config.mjs";
import { BaseMovedError, MergeConflictError, StaleReviewError } from "./errors.mjs";
import { reconcileBaseWithRemote } from "./base-reconcile.mjs";
import { redactSecretLines } from "./leakage.mjs";
import { runSecurityScan } from "./security-scan.mjs";
import {
  findPreparedMerge,
  forgetPreparedMerge,
  forgetPreparedReleaseTag,
  rememberPreparedMerge,
} from "./git-publication.mjs";
import { assertLocalVersionUnchanged } from "./local-version.mjs";
import { classifyPreparedMerge, readPublishedBaseSha } from "./prepared-merge.mjs";
import { publishMergedPullRequest } from "./release-publisher.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  diffPatchId,
  git,
  NO_LFS_FILTER_ARGS,
} from "./workspace.mjs";

const MAX_MERGE_REFUSAL_REASONS = 5;
const MAX_MERGE_REFUSAL_REASON_LENGTH = 300;
const MAX_MERGE_REFUSAL_STATE_LENGTH = 100;

function mergeRefusalText(value, maximumLength) {
  return redactSecretLines(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

/**
 * Explain a merge refusal with the evidence the caller needs to act on.
 *
 * Naming only the required state ("Only an Open / Test OK local PR can be
 * squash merged.") tells the caller nothing about what to fix: the review may
 * have passed while the head went on to conflict with a moved base, and the
 * recorded `reasons` are the only place that distinction lives. Callers see
 * this string and nothing else — Concordia's merge endpoint relays it verbatim
 * — so the actual state and the recorded reasons belong in it. Those values
 * are still bounded, flattened, and redacted before entering the message.
 */
function mergeStateRefusal(pullRequest) {
  const recordedReasons = Array.isArray(pullRequest?.reasons)
    ? pullRequest.reasons.filter((reason) => typeof reason === "string")
    : [];
  const safeReasons = recordedReasons
    .map((reason) => mergeRefusalText(reason, MAX_MERGE_REFUSAL_REASON_LENGTH))
    .filter(Boolean);
  const reasons = safeReasons.slice(0, MAX_MERGE_REFUSAL_REASONS);
  const omittedReasonCount = safeReasons.length - reasons.length;
  const status = mergeRefusalText(
    pullRequest?.status,
    MAX_MERGE_REFUSAL_STATE_LENGTH,
  ) || "unknown";
  const checkStatus = mergeRefusalText(
    pullRequest?.checkStatus,
    MAX_MERGE_REFUSAL_STATE_LENGTH,
  ) || "unknown";
  const observed = `status='${status}', checkStatus='${checkStatus}'`;
  const because = reasons.length > 0
    ? ` Recorded reasons: ${reasons.join(" / ")}${omittedReasonCount > 0 ? ` / ${omittedReasonCount} more` : ""}`
    : "";
  return new Error(
    `Only an Open / Test OK local PR can be squash merged (${observed}).${because}`,
  );
}

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
async function assertMergeSecurityScan({
  worktreePath,
  baseSha,
  env,
  scan,
  allowSystemFailureOverride = false,
}) {
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
    if (allowSystemFailureOverride) return;
    throw new Error(
      `Merge blocked: the pre-merge security scan did not complete (${security.reason}).`,
    );
  }
  // Only a pass or a deliberate skip may advance the base ref. An absent or
  // unrecognised result is not a pass, and this is the last check before the
  // local base branch moves.
  if (security.status !== "passed" && security.status !== "skipped") {
    if (allowSystemFailureOverride) return;
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
      { cause: error, headSha },
    );
  }
  if (!unchanged) {
    throw new StaleReviewError(
      "The head content changed after the review; a new review is required.",
      { headSha },
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

/**
 * squash merge の 1 回分の試行。 GitHub base が独立に進んでいた場合の自動 reconcile
 * (取り込み + 再試行) は wrapper (`squashMergeLocalPullRequest`) が 1 回だけ行う。
 */
async function attemptSquashMerge({
  repository,
  pullRequest,
  env = process.env,
  scan = configuredSecurityScan,
  publish = publishMergedPullRequest,
  allowSystemFailureOverride = false,
  readPublishedBase = readPublishedBaseSha,
  // stdout は CLI のデータ出力なので、マージ経路の診断行は stderr へ出す。
  log = (message) => process.stderr.write(`Revisor: ${message}\n`),
  bypass = null,
}) {
  // バイパスマージ: Revisor / Concordia 自身が落ちていて審査を回せないとき、まず動作を
  // 取り戻すための CLI 限定経路。 審査「状態」のゲート (Test OK であること・審査済み
  // ヘッドと一致すること) だけを外し、実 finding を出したセキュリティスキャンは
  // 通常どおり止める。 外したことは記録に残り、復旧後に後追いレビューできる。
  // 終局済み (merged / closed) はバイパスでも通さない。
  if (pullRequest.status !== "open" || (!bypass && pullRequest.checkStatus !== "test_ok")) {
    throw mergeStateRefusal(pullRequest);
  }
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
  // バイパスでは審査済みヘッドが存在しないことすらある (一度も審査が通っていない)。
  // 突き合わせる相手が無い以上、ここは比較そのものを行わない。
  if (
    !bypass
    && headSha.toLowerCase() !== String(pullRequest.reviewedHeadSha).toLowerCase()
  ) {
    // rebase で SHA だけ変わったヘッドは審査結果を引き継ぐ。差分内容が審査時と
    // 変わっていたら、それは未審査のコードなので再審査へ。
    await assertReviewedContentUnchanged(
      repository.rootPath,
      pullRequest.reviewedHeadSha,
      headSha,
      baseSha,
    );
  }
  // A process can stop after the GitHub push or Release creation and before
  // local state is marked merged. A private recovery ref keeps both tagged
  // Releases and ordinary untagged merges reachable for an idempotent retry.
  const prepared = await findPreparedMerge(repository.rootPath, pullRequest.id);
  if (prepared) {
    // 公開済みの復旧対象だけを再利用する。 未公開のまま base だけが動いた prepared を
    // 再利用すると、 古い親に固定された expectedBaseSha が publish の GitHub 検査を
    // 永久に落とし続ける。
    const decision = await classifyPreparedMerge({
      repository,
      pullRequest,
      prepared,
      baseSha,
      env,
      readPublishedBase,
    });
    if (decision.notice) log(decision.notice);
    if (decision.action === "reuse") {
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
      await forgetPreparedMerge(
        repository.rootPath,
        pullRequest.id,
        prepared.mergeCommitSha,
      );
      return publication;
    }
    // 破棄してから通常経路へ落ちる。 作り直しがコンフリクトした場合は下の
    // MergeConflictError で明示的に失敗し、 古い prepared には戻らない。
    await forgetPreparedMerge(
      repository.rootPath,
      pullRequest.id,
      prepared.mergeCommitSha,
    );
  }
  const root = await mkdtemp(join(tmpdir(), "revisor-squash-merge-"));
  const worktrees = {
    root,
    head: join(root, "integration"),
    base: join(root, "unused"),
  };
  try {
    await git(repository.rootPath, [
      ...NO_LFS_FILTER_ARGS,
      "worktree", "add", "--detach", worktrees.head, baseSha,
    ]);
    try {
      // A squash merge always stages a single-parent result. Git rejects
      // `--no-ff` together with `--squash`, so do not add a fast-forward flag.
      await git(worktrees.head, [
        ...NO_LFS_FILTER_ARGS,
        "merge", "--squash", "--no-commit", headSha,
      ]);
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
      // スキャン基盤ごと落ちている状況が、そもそもバイパスを使う場面。 実 finding は
      // バイパスでも止まる (`assertMergeSecurityScan` は findings を無条件で拒否する)。
      allowSystemFailureOverride: allowSystemFailureOverride || Boolean(bypass),
    });
    await rememberPreparedMerge(repository.rootPath, pullRequest.id, mergeCommitSha);
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
    await forgetPreparedMerge(repository.rootPath, pullRequest.id, mergeCommitSha);
    return publication;
  } finally {
    await cleanupWorktrees(repository.rootPath, worktrees);
  }
}

export async function squashMergeLocalPullRequest(input) {
  try {
    return await attemptSquashMerge(input);
  } catch (error) {
    if (!(error instanceof BaseMovedError)) throw error;
    // GitHub 側だけが進んだ状態は定型修復できる: 先行コミットをローカル base へ
    // 取り込み (ff / クリーン merge のみ、 コンフリクトは人間へ)、 進んだ base の上で
    // squash をやり直す。 失敗した試行の prepared merge は旧 base を親に持つため捨てる
    // (捨てないと再試行も同じ乖離判定で止まる)。 再試行は 1 回だけ — reconcile 直後に
    // また乖離するなら別の書き込み主体がいるので、 隠さず従来のエラーで止める。
    const reconcile = input.reconcileBase ?? reconcileBaseWithRemote;
    const prepared = await findPreparedMerge(input.repository.rootPath, input.pullRequest.id);
    if (prepared) {
      await forgetPreparedMerge(input.repository.rootPath, input.pullRequest.id, prepared.mergeCommitSha);
      if (prepared.tag) {
        await forgetPreparedReleaseTag(
          input.repository.rootPath,
          prepared.tag,
          prepared.mergeCommitSha,
        );
      }
    }
    await reconcile({
      repository: input.repository,
      baseRef: input.pullRequest.baseRef,
      env: input.env ?? process.env,
    });
    return attemptSquashMerge(input);
  }
}
