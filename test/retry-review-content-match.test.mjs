import assert from "node:assert/strict";
import test from "node:test";
import { retryReviewScope } from "../src/retry-review.mjs";

function reviewed(overrides = {}) {
  return {
    intentReviewCompleted: true,
    reviewedHeadSha: "a".repeat(40),
    reasons: [],
    error: null,
    ...overrides,
  };
}

// 引き継ぎの条件は「審査したときと内容が同じ」であって SHA が同じことではない。
// base が動くたびに載せ替えが要る運用で SHA 一致を条件にすると、載せ替えのたびに
// 最も高いモデルレビューを払い直すことになる。
test("a re-landed head keeps its review when the diff content is unchanged", () => {
  const scope = retryReviewScope(reviewed(), "b".repeat(40), { reviewedContentUnchanged: true });
  assert.equal(scope.reviewMode, "verification");
  assert.equal(scope.reusedReview.matchedBy, "diff_content");
  assert.equal(scope.reusedReview.reviewedHeadSha, "a".repeat(40));
});

// 内容が変わっているなら未審査のコード。 SHA が同じでも引き継がない側に倒す。
test("a changed diff falls back to a full review even when the caller says nothing", () => {
  const scope = retryReviewScope(reviewed(), "b".repeat(40), { reviewedContentUnchanged: false });
  assert.equal(scope.reviewMode, "full");
  assert.deepEqual(scope.verificationTargets, []);
});

test("the same head still inherits without a caller decision", () => {
  const scope = retryReviewScope(reviewed(), "a".repeat(40));
  assert.equal(scope.reviewMode, "verification");
  assert.equal(scope.reusedReview.matchedBy, "head_sha");
});

// モデルレビュー自身が問題を指摘した審査は、内容が同じでも引き継がない。
test("a reviewer-reported hold is not inherited by a re-landed head", () => {
  const scope = retryReviewScope(
    reviewed({ reasons: ["reviewer reported PR_GATE_NEEDS_HUMAN"] }),
    "b".repeat(40),
    { reviewedContentUnchanged: true },
  );
  assert.equal(scope.reviewMode, "full");
});

test("an unfinished intent review is not inherited", () => {
  const scope = retryReviewScope(
    reviewed({ intentReviewCompleted: false }),
    "b".repeat(40),
    { reviewedContentUnchanged: true },
  );
  assert.equal(scope.reviewMode, "full");
});
