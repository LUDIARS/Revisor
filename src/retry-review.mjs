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

export function retryReviewScope(pullRequest, currentHeadSha) {
  const reasons = Array.isArray(pullRequest?.reasons) ? pullRequest.reasons : [];
  const sameReviewedHead = typeof pullRequest?.reviewedHeadSha === "string"
    && pullRequest.reviewedHeadSha.toLowerCase() === String(currentHeadSha).toLowerCase();
  if (pullRequest?.intentReviewCompleted !== true
      || reasons.some((reason) => REVIEW_REASON.test(reason))
      || REVIEW_ERROR.test(String(pullRequest?.error ?? ""))) {
    return { reviewMode: "full", verificationTargets: [] };
  }
  const verificationTargets = failedVerificationTargets(pullRequest);
  const previousPlanWasAdvised = pullRequest?.reviewPlan?.source === "advised";
  const reuseFailedTargets = sameReviewedHead
    && !previousPlanWasAdvised
    && verificationTargets.length > 0;
  return {
    reviewMode: "verification",
    verificationTargets: reuseFailedTargets
      ? verificationTargets
      : [...ALL_DETERMINISTIC_TARGETS],
  };
}
