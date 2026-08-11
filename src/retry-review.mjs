const REVIEW_REASON = /reviewer reported|Genius decision/i;
const REVIEW_ERROR = /(?:opposite-model|reviewer) review(?:er)? failed/i;
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
 * 引き継ぎの条件は「審査したときと**内容**が同じ」であって、SHA が同じことではない。
 * base が動くたびに載せ替えが要る運用で SHA 一致を条件にすると、載せ替えのたびに
 * 最も高いモデルレビューを払い直すことになる。呼び出し側が内容一致を判定して
 * `reviewedContentUnchanged` で渡す (`local-pr-service.mjs` が patch-id で見る)。
 * 渡されなければ従来どおり SHA 一致だけで判断する。
 */
export function retryReviewScope(pullRequest, currentHeadSha, { reviewedContentUnchanged } = {}) {
  const reasons = Array.isArray(pullRequest?.reasons) ? pullRequest.reasons : [];
  const sameReviewedHead = reviewedContentUnchanged ?? (
    typeof pullRequest?.reviewedHeadSha === "string"
    && pullRequest.reviewedHeadSha.toLowerCase() === String(currentHeadSha).toLowerCase()
  );
  if (pullRequest?.intentReviewCompleted !== true
      || !sameReviewedHead
      || reasons.some((reason) => REVIEW_REASON.test(reason))
      || REVIEW_ERROR.test(String(pullRequest?.error ?? ""))) {
    return { reviewMode: "full", verificationTargets: [] };
  }
  const verificationTargets = failedVerificationTargets(pullRequest);
  const previousPlanWasAdvised = pullRequest?.reviewPlan?.source === "advised";
  const reuseFailedTargets = !previousPlanWasAdvised
    && verificationTargets.length > 0;
  return {
    reviewMode: "verification",
    verificationTargets: reuseFailedTargets
      ? verificationTargets
      : [...ALL_DETERMINISTIC_TARGETS],
    // 何を飛ばしたかを外に出す。 黙って飛ばすと、通っていない段階が通ったように
    // 見える事故になる。 SHA が変わっているのに引き継いだ場合は特に、根拠 (内容一致)
    // が記録に残っている必要がある。
    reusedReview: {
      reviewedHeadSha: pullRequest.reviewedHeadSha ?? null,
      currentHeadSha: String(currentHeadSha),
      matchedBy: pullRequest?.reviewedHeadSha
        && pullRequest.reviewedHeadSha.toLowerCase() === String(currentHeadSha).toLowerCase()
        ? "head_sha"
        : "diff_content",
    },
  };
}
