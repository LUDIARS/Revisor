import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings } from "./config.mjs";
import { BaseMovedError, MergeConflictError, StaleReviewError } from "./errors.mjs";
import { relandHeadOnBase } from "./base-relanding.mjs";
import { reconcileBaseWithRemote } from "./base-reconcile.mjs";
import { redactSecretLines } from "./leakage.mjs";
import { runSecurityScan } from "./security-scan.mjs";
import {
  findPreparedMerge,
  forgetPreparedMerge,
  forgetPreparedReleaseTag,
  rememberPreparedMerge,
} from "./git-publication.mjs";
import { assertLocalVersionUnchangedAgainstRegisteredBase } from "./local-version.mjs";
import { rememberPendingPublish } from "./pending-publish.mjs";
import { isDeferredPublication } from "./publication-state.mjs";
import { classifyPreparedMerge, readPublishedBaseSha } from "./prepared-merge.mjs";
import { publishMergedPullRequest } from "./release-publisher.mjs";
import { serviceLog } from "./service-log.mjs";
import {
  advanceLocalBranch,
  assertSafeSha,
  cleanupWorktrees,
  diffPatchId,
  git,
  gitWithoutLfs,
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

// A retry can run after another process has already advanced the local base
// beyond the prepared merge.  In that case advancing the branch *to* the
// prepared commit would be a non-fast-forward update, even though the merge
// is already present.  Keep the newer local base and only use the normal
// advance path when the prepared commit is not yet reachable from it.
async function localBaseContainsPreparedMerge(rootPath, baseSha, mergeCommitSha) {
  try {
    const mergeBase = await git(rootPath, ["merge-base", baseSha, mergeCommitSha]);
    return mergeBase.toLowerCase() === mergeCommitSha.toLowerCase();
  } catch {
    return false;
  }
}

async function hasStagedChanges(worktreePath) {
  return Boolean((await git(worktreePath, ["diff", "--cached", "--name-only"])).trim());
}

// An empty re-landing is safe only when the reviewed patch is already on the
// base. A head may also become empty because somebody reset it and discarded
// the reviewed work; `git cherry` distinguishes the equivalent-patch case
// without trusting the branch pointer alone.
async function assertReviewedContentAlreadyLanded(rootPath, reviewedHeadSha, baseSha) {
  try {
    assertSafeSha(reviewedHeadSha, "reviewed head sha");
    assertSafeSha(baseSha, "base sha");
    const cherry = await git(rootPath, ["cherry", baseSha, reviewedHeadSha]);
    if (!cherry.split(/\r?\n/).some((line) => line.startsWith("+"))) return;
  } catch (error) {
    throw new StaleReviewError(
      "The reviewed head cannot be verified against the current base; a new review is required.",
      { cause: error, headSha: reviewedHeadSha },
    );
  }
  throw new StaleReviewError(
    "The reviewed content is not present on the current base; a new review is required.",
    { headSha: reviewedHeadSha },
  );
}

/**
 * GitHub 送出を保留したマージだけを記録する。
 *
 * 記録は base ref を前進させる前に行う: 先に base が動いてから記録前に落ちると、
 * 「ローカルには入っているが保留の記録が無い」= 永久に送られない変更になる。
 */
async function recordDeferredPublication({
  rootPath,
  localPrId,
  mergeCommitSha,
  publication,
  log,
}) {
  if (!isDeferredPublication(publication)) return;
  await rememberPendingPublish(rootPath, localPrId, mergeCommitSha);
  log(
    `GitHub publish を保留しました (${publication.deferredReason}) — `
    + "ローカルのマージは完了しています。 後で 'revisor publish-pending' を実行してください。",
  );
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
  // 明示保留。 CLI の `--defer-push` だけがここを true にする。
  deferPush = false,
  allowSystemFailureOverride = false,
  readPublishedBase = readPublishedBaseSha,
  // stdout は CLI のデータ出力なので、マージ経路の診断行は stderr へ出す。
  // 人間向けの 1 行通知はこちら、 機械可読な段階記録は serviceLog 側と役割を分ける。
  log = (message) => process.stderr.write(`Revisor: ${message}\n`),
  bypass = null,
  // 構造化された段階記録。 人間向けの log とは役割が違うので引数を分ける。
  logEvent = serviceLog,
}) {
  // バイパスマージ: Revisor / Concordia 自身が落ちていて審査を回せないとき、まず動作を
  // 取り戻すための CLI 限定経路。 審査「状態」のゲート (Test OK であること・審査済み
  // ヘッドと一致すること) だけを外し、実 finding を出したセキュリティスキャンは
  // 通常どおり止める。 外したことは記録に残り、復旧後に後追いレビューできる。
  // 終局済み (merged / closed) はバイパスでも通さない。
  const subject = {
    repository: repository.repository,
    localPrId: pullRequest.id,
    number: pullRequest.number,
    headRef: pullRequest.headRef,
    baseRef: pullRequest.baseRef,
  };
  if (pullRequest.status !== "open" || (!bypass && pullRequest.checkStatus !== "test_ok")) {
    logEvent("merge_refused", {
      ...subject,
      status: pullRequest.status,
      checkStatus: pullRequest.checkStatus,
    }, { level: "warn" });
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
  logEvent("merge_attempt_started", {
    ...subject,
    baseSha,
    headSha,
    reviewedHeadSha: pullRequest.reviewedHeadSha,
  });
  // 突合先は隔離リポジトリの凍結 base ではなく登録 checkout の base。 凍結 base は
  // 登録側が後から commit した版数ファイルを知らないので、 そこと比べると無関係な PR が
  // まとめて止まる (理由は local-version.mjs 側に記載)。
  await assertLocalVersionUnchangedAgainstRegisteredBase(repository, {
    baseRef: pullRequest.baseRef,
    headRef: pullRequest.headRef,
  });
  // バイパスでは審査済みヘッドが存在しないことすらある (一度も審査が通っていない)。
  // 突き合わせる相手が無い以上、ここは比較そのものを行わない。
  if (
    !bypass
    && headSha.toLowerCase() !== String(pullRequest.reviewedHeadSha).toLowerCase()
  ) {
    logEvent("merge_head_moved_since_review", { ...subject, baseSha, headSha });
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
      logEvent("merge_prepared_reused", {
        ...subject,
        mergeCommitSha: prepared.mergeCommitSha,
        tag: prepared.tag ?? null,
      });
      const publication = await publish({
        repository,
        pullRequest,
        expectedBaseSha,
        mergeCommitSha: prepared.mergeCommitSha,
        preparedTag: prepared.tag,
        deferPush,
        env,
      });
      await recordDeferredPublication({
        rootPath: repository.rootPath,
        localPrId: pullRequest.id,
        mergeCommitSha: prepared.mergeCommitSha,
        publication,
        log,
      });
      if (!await localBaseContainsPreparedMerge(
        repository.rootPath,
        baseSha,
        prepared.mergeCommitSha,
      )) {
        await advanceLocalBranch(
          repository.rootPath,
          pullRequest.baseRef,
          baseSha,
          prepared.mergeCommitSha,
        );
      }
      await forgetPreparedMerge(
        repository.rootPath,
        pullRequest.id,
        prepared.mergeCommitSha,
      );
      logEvent("merge_completed", {
        ...subject,
        baseSha,
        mergeCommitSha: prepared.mergeCommitSha,
        releaseTag: publication?.releaseTag ?? null,
      });
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
    // 載せ替えは Revisor が受け持つ (`review-diff-scope.md` 規則 3)。 進んだ base の上へ
    // head の正味の変更を載せ直し、 衝突したときだけ、 衝突したファイルの一覧を添えて
    // 提出元へ返す。 セッションに rebase をやり直させない。
    try {
      await relandHeadOnBase({
        repoPath: repository.rootPath,
        worktreePath: worktrees.head,
        baseSha,
        headSha,
        baseRef: pullRequest.baseRef,
      });
    } catch (error) {
      if (error instanceof MergeConflictError) {
        logEvent("merge_conflict_detected", {
          ...subject,
          baseSha,
          headSha,
          conflictFiles: error.conflictedPaths,
          gitMessage: error.message,
        }, { level: "warn" });
      }
      throw error;
    }
    // A branch can be rebased onto a main that already contains its complete
    // patch. Treat that as a logical no-op merge instead of trying to create
    // an empty commit in the detached integration worktree.
    if (!await hasStagedChanges(worktrees.head)) {
      if (!bypass) {
        await assertReviewedContentAlreadyLanded(
          repository.rootPath,
          pullRequest.reviewedHeadSha,
          baseSha,
        );
      }
      log(`Local PR ${pullRequest.id}: no remaining diff after re-landing on ${pullRequest.baseRef}.`);
      return baseSha;
    }
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
    // commit も index を洗い直す過程でフィルタを起動する。 worktree add と
    // merge --squash だけ無効化しても、 最後のこの 1 本で git-lfs 不在に落ちる。
    await gitWithoutLfs(worktrees.head, [
      "-c",
      "user.name=LUDIARS Revisor",
      "-c",
      "user.email=revisor@localhost",
      "commit",
      "-m",
      ...commitMessage(pullRequest),
    ]);
    const mergeCommitSha = await git(worktrees.head, ["rev-parse", "HEAD"]);
    logEvent("merge_squash_committed", { ...subject, baseSha, mergeCommitSha });
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
      deferPush,
      env,
    });
    await recordDeferredPublication({
      rootPath: repository.rootPath,
      localPrId: pullRequest.id,
      mergeCommitSha,
      publication,
      log,
    });
    await advanceLocalBranch(
      repository.rootPath,
      pullRequest.baseRef,
      baseSha,
      mergeCommitSha,
    );
    await forgetPreparedMerge(repository.rootPath, pullRequest.id, mergeCommitSha);
    logEvent("merge_completed", {
      ...subject,
      baseSha,
      mergeCommitSha,
      releaseTag: publication?.releaseTag ?? null,
    });
    return publication;
  } finally {
    await cleanupWorktrees(repository.rootPath, worktrees);
  }
}

export async function squashMergeLocalPullRequest(input) {
  const logEvent = input.logEvent ?? serviceLog;
  try {
    return await attemptSquashMerge(input);
  } catch (error) {
    if (!(error instanceof BaseMovedError)) throw error;
    logEvent("merge_base_reconcile_started", {
      repository: input.repository.repository,
      localPrId: input.pullRequest.id,
      number: input.pullRequest.number,
      baseRef: input.pullRequest.baseRef,
      reason: error.message,
    }, { level: "warn" });
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
