import assert from "node:assert/strict";
import test from "node:test";
import { LocalPrReporter } from "../src/local-reporter.mjs";
import { retryReviewScope } from "../src/retry-review.mjs";

const HEAD = "b".repeat(40);

function storeDouble(initial = {}) {
  const record = { id: "PR1", ...initial };
  return {
    record,
    updatePullRequest(id, patch) {
      assert.equal(id, "PR1");
      Object.assign(record, patch);
      return record;
    },
    getPullRequest: () => record,
    appendPullRequestEvent() {},
  };
}

test("the checkpoint is written before the review finishes, leaving the status running", async () => {
  const store = storeDouble({
    checkStatus: "running",
    headSha: HEAD,
    intentReviewCompleted: false,
  });
  const reporter = new LocalPrReporter(store);

  await reporter.intentReviewCompleted({
    localPrId: "PR1",
    reviewedHeadSha: HEAD,
    reviewer: "codex",
    plan: { source: "deterministic" },
  });

  assert.equal(store.record.intentReviewCompleted, true);
  assert.equal(store.record.reviewedHeadSha, HEAD);
  assert.equal(store.record.reviewer, "codex");
  // The review is not done: only the part that cannot be repeated cheaply is.
  assert.equal(store.record.checkStatus, "running");
});

test("a review interrupted after the checkpoint resumes without the model review", async () => {
  const store = storeDouble({
    checkStatus: "running",
    headSha: HEAD,
    intentReviewCompleted: false,
    reasons: [],
  });
  const reporter = new LocalPrReporter(store);
  await reporter.intentReviewCompleted({
    localPrId: "PR1",
    reviewedHeadSha: HEAD,
    reviewer: "codex",
    plan: { source: "deterministic" },
  });

  // What recoverInterruptedReviews() feeds into #requeue after a restart.
  assert.equal(retryReviewScope(store.record, HEAD).reviewMode, "verification");
});

test("a review interrupted before the checkpoint still pays for the model review", () => {
  const before = { checkStatus: "running", intentReviewCompleted: false, reasons: [] };

  assert.equal(retryReviewScope(before, HEAD).reviewMode, "full");
});

test("the checkpoint does not survive a head change", async () => {
  const store = storeDouble({ checkStatus: "running", headSha: HEAD, reasons: [] });
  const reporter = new LocalPrReporter(store);
  await reporter.intentReviewCompleted({
    localPrId: "PR1",
    reviewedHeadSha: HEAD,
    reviewer: "codex",
    plan: { source: "advised" },
  });

  // A rebase or an autofix commit moves the head; the reviewed content is no
  // longer the content being merged, so the full review reruns.
  const scope = retryReviewScope(store.record, "c".repeat(40));
  assert.equal(scope.reviewMode, "full");
  assert.deepEqual(scope.verificationTargets, []);
});

test("a superseded worker cannot checkpoint the newer review", async () => {
  const store = storeDouble({
    checkStatus: "running",
    headSha: HEAD,
    jobId: "current-job",
    intentReviewCompleted: false,
  });
  const reporter = new LocalPrReporter(store);

  await reporter.intentReviewCompleted({
    localPrId: "PR1",
    jobId: "superseded-job",
    reviewedHeadSha: HEAD,
    reviewer: "codex",
    plan: { source: "deterministic" },
  });

  assert.equal(store.record.intentReviewCompleted, false);
  assert.equal(store.record.reviewedHeadSha, undefined);
});
