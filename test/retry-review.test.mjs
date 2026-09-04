import assert from "node:assert/strict";
import test from "node:test";
import { retryReviewScope } from "../src/retry-review.mjs";

const HEAD = "a".repeat(40);

// 審査結果の引き継ぎ (fdb8fdc) で reusedReview が返るようになった。 どの head の結果を
// 再利用したかは verification の前提そのものなので、 期待値にも含めて固定する。
function reused(reviewedHeadSha, currentHeadSha, matchedBy = "head_sha") {
  return { reviewedHeadSha, currentHeadSha, matchedBy };
}

// 完走した審査が残す段階記録と成果。 段階フラグだけでは引き継がない (成果が無い段階は
// 再検証で読めない) ので、成果も一緒に置く。
function reviewedPullRequest(overrides = {}, headSha = HEAD) {
  const stage = { completed: true, headSha, at: "2026-08-21T00:00:00.000Z" };
  return {
    reviewedHeadSha: headSha,
    reviewStages: {
      anatomia: stage,
      tests: stage,
      review: stage,
      security: stage,
    },
    anatomia: { domain: {}, quality: {}, architecture: {} },
    ci: [{ name: "unit", status: "passed" }],
    security: { status: "passed" },
    reasons: [],
    ...overrides,
  };
}

test("rechecks only failed deterministic gates on an unchanged reviewed head", () => {
  assert.deepEqual(retryReviewScope(reviewedPullRequest({
    reasons: ["1 registered test case(s) failed"],
    security: { status: "skipped", reason: "registered tests failed" },
  }), HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "security"],
    reusedStages: ["anatomia", "review"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("reruns intent review when the reviewer rejected the prior result", () => {
  assert.equal(retryReviewScope(reviewedPullRequest({
    reasons: ["reviewer reported insufficient information for a safe domain/spec definition"],
  }), HEAD).reviewMode, "full");
});

test("reruns intent review after the head changes", () => {
  assert.deepEqual(retryReviewScope(reviewedPullRequest({
    reasons: ["Anatomia gate(s) did not pass: duplication"],
  }), "b".repeat(40)), {
    reviewMode: "full",
    verificationTargets: [],
  });
});

test("keeps every stage that passed for this head and only rescans the leakage gate", () => {
  assert.deepEqual(retryReviewScope(reviewedPullRequest(), HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage"],
    reusedStages: ["anatomia", "tests", "review", "security"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("rechecks every deterministic gate when the previous plan was advised", () => {
  assert.deepEqual(retryReviewScope(reviewedPullRequest({
    reviewPlan: { source: "advised" },
    reasons: ["1 registered test case(s) failed"],
  }), HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "anatomia", "security"],
    reusedStages: ["review"],
    reusedReview: reused(HEAD, HEAD),
  });
});

test("reruns intent review when a pre-review test autofix never reached it", () => {
  assert.equal(retryReviewScope({
    reviewedHeadSha: HEAD,
    reviewStages: { tests: { completed: true, headSha: HEAD } },
    ci: [{ name: "unit", status: "passed" }],
    reasons: ["1 registered test case(s) failed"],
  }, HEAD).reviewMode, "full");
});

// この変更より前に書かれたレコードには段階記録が無い。 旧 `intentReviewCompleted` は
// モデルレビューの通過としてだけ読み替え、決定的段階は全部やり直す。
test("a record written before the stage flags still inherits its model review", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: [],
  }, HEAD), {
    reviewMode: "verification",
    verificationTargets: ["leakage", "tests", "anatomia", "security"],
    reusedStages: ["review"],
    reusedReview: reused(HEAD, HEAD),
  });
});

// フラグだけ残って成果が消えた段階を通過扱いにすると、再検証が前回結果を読めずに落ちる。
test("a stage whose outcome is missing is not treated as passed", () => {
  const scope = retryReviewScope(reviewedPullRequest({ anatomia: null }), HEAD);
  assert.deepEqual(scope.verificationTargets, ["leakage", "anatomia"]);
  assert.deepEqual(scope.reusedStages, ["tests", "review", "security"]);
});

test("a security scan skipped by a failed prerequisite is not treated as passed", () => {
  const scope = retryReviewScope(reviewedPullRequest({
    security: { status: "skipped", reason: "registered tests failed" },
  }), HEAD);
  assert.deepEqual(scope.verificationTargets, ["leakage", "security"]);
  assert.deepEqual(scope.reusedStages, ["anatomia", "tests", "review"]);
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
    // 衝突解消で引き継ぐのはモデルレビューだけ。 決定論的検査は内容が変わって
    // いる以上やり直す。
    reusedStages: ["review"],
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
