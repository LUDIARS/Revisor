import assert from "node:assert/strict";
import test from "node:test";
import { retryReviewScope } from "../src/retry-review.mjs";

const HEAD = "a".repeat(40);

test("rechecks only failed deterministic gates on an unchanged reviewed head", () => {
  assert.deepEqual(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: true,
    reasons: ["1 registered test case(s) failed"],
    security: { status: "skipped", reason: "registered tests failed" },
  }, HEAD), {
    reviewMode: "verification",
    verificationTargets: ["tests", "security"],
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
  });
});

test("reruns intent review when a pre-review test autofix never reached it", () => {
  assert.equal(retryReviewScope({
    reviewedHeadSha: HEAD,
    intentReviewCompleted: false,
    reasons: ["1 registered test case(s) failed"],
  }, HEAD).reviewMode, "full");
});
