import assert from "node:assert/strict";
import test from "node:test";
import { retryReviewScope } from "../src/retry-review.mjs";

const HEAD = "a".repeat(40);

// 審査結果の引き継ぎ (fdb8fdc) で reusedReview が返るようになった。 どの head の結果を
// 再利用したかは verification の前提そのものなので、 期待値にも含めて固定する。
function reused(reviewedHeadSha, currentHeadSha, matchedBy = "head_sha") {
  return { reviewedHeadSha, currentHeadSha, matchedBy };
}

test("rechecks only failed deterministic gates on an unchanged reviewed head", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: ["1 registered test case(s) failed"],
    security: { status: "skipped", reason: "registered tests failed" },
  }, HEAD), {
    reviewMode: "verification",
    verificationTargets: ["tests", "security"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("reruns intent review when the reviewer rejected the prior result", () => {
  assert.equal(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: ["reviewer reported insufficient information for a safe domain/spec definition"],
  }, HEAD).reviewMode, "full");
});

test("reruns intent review after the head changes", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: ["Anatomia gate(s) did not pass: duplication"],
  }, "b".repeat(40)), {
    reviewMode: "full",
    verificationTargets: [],
  });
});

test("keeps a completed intent review and deterministically rechecks a settled head", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: [],
  }, HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "anatomia", "security"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("rechecks every deterministic gate when the previous plan was advised", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reviewPlan: { source: "advised" },
    reasons: ["1 registered test case(s) failed"],
  }, HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "anatomia", "security"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("reruns intent review when a pre-review test autofix never reached it", () => {
  assert.equal(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: false,
    reasons: ["1 registered test case(s) failed"],
  }, HEAD).reviewMode, "full");
});

// 審査通過後に base との衝突でマージが落ち、 衝突解消で差分内容が変わった head。
// neco 判断 (2026-08-22): モデルレビューは飛ばし、 決定論的検査だけ全部回す。
test("skips intent review after a merge conflict even when the resolved content differs", () => {
  const resolved = "c".repeat(40);
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: ["The head conflicts with the current 'main' in 1 file(s): src/a.mjs"],
    mergeConflictAfterReview: { reviewedHeadSha: HEAD, conflictedPaths: ["src/a.mjs"] },
  }, resolved, { reviewedContentUnchanged: false }), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "anatomia", "security"],
    reusedReview: reused(HEAD, resolved, "merge_conflict_resolution"),
  });
});

test("ignores a conflict record that belongs to an older review", () => {
  assert.equal(retryReviewScope({
    reviewedHeadSha: "d".repeat(40),
    intentReviewCompleted: true,
    reasons: [],
    mergeConflictAfterReview: { reviewedHeadSha: HEAD },
  }, "c".repeat(40), { reviewedContentUnchanged: false }).reviewMode, "full");
});
