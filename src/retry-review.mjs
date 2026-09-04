import {
  completedStagesForHead,
  DETERMINISTIC_REVIEW_STAGES,
  REVIEW_STAGES,
  reviewedHeadShaOf,
} from "./review-stage-progress.mjs";

const REVIEW_REASON = /reviewer reported|Genius decision/i;
const REVIEW_ERROR = /(?:opposite-model|reviewer) review(?:er)? failed/i;
// 出力順を固定する。 `leakage` は段階フラグを持たず常にやり直す (差分から即座に
// 再計算でき、 worker コストも掛からない)。
const ALL_DETERMINISTIC_TARGETS = ["leakage", "tests", "anatomia", "security"];

export function failedVerificationTargets(pullRequest) {
  const reasons = Array.isArray(pullRequest?.reasons) ? pullRequest.reasons : [];
  const targets = new Set();
  for (const reason of reasons) {
    if (/registered test/i.test(reason)) targets.add("tests");
    if (/information leakage/i.test(reason)) targets.add("leakage");
    if (/target domain|Anatomia|architecture|complexity/i.test(reason)) targets.add("anatomia");
    if (/security scan|security finding/i.test(reason)) targets.add("security");
  }
  const error = String(pullRequest?.error ?? "");
  if (/test|npm|pnpm|vitest/i.test(error)) targets.add("tests");
  if (/Anatomia/i.test(error)) targets.add("anatomia");
  if (/security|codex-security/i.test(error)) targets.add("security");
  if (/leak/i.test(error)) targets.add("leakage");

  if (targets.has("tests") && pullRequest?.security?.status === "skipped") {
    targets.add("security");
  }
  if (targets.has("leakage") && pullRequest?.security?.status === "skipped") {
    targets.add("security");
  }
  return [...targets];
}

/**
 * 再審査で何をやり直すかを決める。
 *
 * 判断材料は段階ごとの通過フラグ (`review-stage-progress.mjs`)。 各段階は終わった
 * 時点で永続化されるので、 途中でプロセスが落ちても通過した分だけ進捗が積み上がり、
 * 再投入では残りの段階だけを実行する。
 *
 * 引き継ぎの条件は「審査したときと**内容**が同じ」であって、SHA が同じことではない。
 * base が動くたびに載せ替えが要る運用で SHA 一致を条件にすると、載せ替えのたびに
 * 最も高いモデルレビューを払い直すことになる。呼び出し側が内容一致を判定して
 * `reviewedContentUnchanged` で渡す (`local-pr-service.mjs` が patch-id で見る)。
 * 渡されなければ段階ごとの head SHA 一致だけで判断する。
 */
export function retryReviewScope(pullRequest, currentHeadSha, { reviewedContentUnchanged } = {}) {
  const reasons = Array.isArray(pullRequest?.reasons) ? pullRequest.reasons : [];
  // 衝突解消は差分内容が変わっていてもモデルレビューを払い直さない
  // (neco 判断 2026-08-22)。 段階フラグは内容一致を条件に引き継ぐので、
  // このときだけは「内容が変わっていても review 段階は引き継ぐ」を別に見る。
  const resolvedConflict = conflictResolutionAfterReview(pullRequest);
  const contentUnchanged = reviewedContentUnchanged === true;
  const completed = completedStagesForHead(pullRequest, {
    headSha: currentHeadSha,
    contentUnchanged,
  });
  const reviewRejected = reasons.some((reason) => REVIEW_REASON.test(reason))
    || REVIEW_ERROR.test(String(pullRequest?.error ?? ""));
  // 衝突解消のときは head SHA 一致を条件から外して review 段階だけを見る
  // (`contentUnchanged: true` が SHA 照合を飛ばす)。 成果が残っているかの
  // 確認は同じ関数が行うので、判定規則を二重に持たない。
  const reviewReusable = completed.has("review")
    || (resolvedConflict
      && completedStagesForHead(pullRequest, { headSha: currentHeadSha, contentUnchanged: true })
        .has("review"));
  if (!reviewReusable || reviewRejected) {
    return { reviewMode: "full", verificationTargets: [] };
  }
  const failed = new Set(failedVerificationTargets(pullRequest));
  // 助言された plan は、その plan を作った前提ごと捨てる。 決定的段階の通過は
  // 引き継がず全部やり直す (従来の挙動)。 衝突解消も同じで、 差分内容が変わって
  // いる以上、 決定論的検査は全部回す — 引き継ぐのはモデルレビューだけ。
  const previousPlanWasAdvised = pullRequest?.reviewPlan?.source === "advised";
  const rerun = new Set(["leakage"]);
  for (const stage of DETERMINISTIC_REVIEW_STAGES) {
    if (previousPlanWasAdvised || resolvedConflict || failed.has(stage) || !completed.has(stage)) {
      rerun.add(stage);
    }
  }
  // 引き継ぐと決めた段階をそのまま並べる。 衝突解消の review は head SHA が
  // 変わっているので `completed` に入らないが、実際には引き継いでいる。
  // ここで拾わないと「飛ばしたのに飛ばしたと書かれていない」記録になる。
  const reused = new Set([...completed].filter((stage) => !rerun.has(stage)));
  if (reviewReusable && !rerun.has("review")) reused.add("review");
  const reusedStages = REVIEW_STAGES.filter((stage) => reused.has(stage));
  const reviewedHeadSha = reviewedHeadShaOf(pullRequest);
  return {
    reviewMode: "verification",
    verificationTargets: ALL_DETERMINISTIC_TARGETS.filter((target) => rerun.has(target)),
    // 何を飛ばしたかを外に出す。 黙って飛ばすと、通っていない段階が通ったように
    // 見える事故になる。 SHA が変わっているのに引き継いだ場合は特に、根拠 (内容一致)
    // が記録に残っている必要がある。
    reusedStages,
    reusedReview: {
      reviewedHeadSha,
      currentHeadSha: String(currentHeadSha),
      matchedBy: reviewedHeadSha
        && reviewedHeadSha.toLowerCase() === String(currentHeadSha).toLowerCase()
        ? "head_sha"
        : contentUnchanged
          ? "diff_content"
          : "merge_conflict_resolution",
    },
  };
}

/**
 * 審査通過後に base との衝突でマージが落ちた PR は、 衝突解消で差分内容が変わっていても
 * モデルレビューを払い直さない (neco 判断 2026-08-22)。 決定論的検査は全部回す。
 * 記録 (`mergeConflictAfterReview`) は local-pr-service がマージ失敗時に書き、
 * 再投入時に消費する。 審査済み SHA が別の審査で置き換わっていたら引き継がない。
 */
export function conflictResolutionAfterReview(pullRequest) {
  const record = pullRequest?.mergeConflictAfterReview;
  if (!record || typeof record.reviewedHeadSha !== "string") return false;
  return typeof pullRequest?.reviewedHeadSha === "string"
    && record.reviewedHeadSha.toLowerCase() === pullRequest.reviewedHeadSha.toLowerCase();
}
