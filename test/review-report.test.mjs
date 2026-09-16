import assert from "node:assert/strict";
import test from "node:test";
import { pendingReviewProjection } from "../src/local-reporter.mjs";
import {
  createReviewReport,
  finalReviewReportEntry,
  redactedReviewerOutput,
  reviewReportEntry,
  updateReviewReport,
} from "../src/review-report.mjs";
import { retainedStageProjection } from "../src/review-stage-progress.mjs";

const ATTEMPT = "job-1";
const HEAD = "a".repeat(40);
const AT = "2026-09-12T00:00:00.000Z";
const SECRET_LINE = "token=\"abcdefghijklmnopqrstuvwxyz012345\"";

test("keeps one stable entry per attempt and replaces stage updates", () => {
  const created = createReviewReport({ attemptId: ATTEMPT, headSha: HEAD, at: AT });
  const updated = updateReviewReport(created, {
    id: "stage:tests", kind: "check", label: "Tests", status: "running", at: AT, content: "started",
  });
  const completed = updateReviewReport(updated, {
    id: "stage:tests", kind: "check", label: "Tests", status: "passed", at: AT, content: "passed",
  });
  assert.equal(completed.entries.filter((entry) => entry.id === "stage:tests").length, 1);
  assert.equal(completed.entries.find((entry) => entry.id === "stage:tests").status, "passed");
});

test("records Augur runs and evidence as Japanese behavior and experience blocks", () => {
  const entry = reviewReportEntry("tests", {
    ci: [
      { domain: "billing", total: 3, passed: 2, failed: 1, durationMs: 12, runId: "r-billing" },
      { experience: { status: "recorded", count: 2 } },
    ],
  });
  assert.equal(entry.label, "動作ブロック・体験ブロック");
  assert.deepEqual(entry.content.動作ブロック.runs[0], {
    domain: "billing", passed: 2, failed: 1, durationMs: 12, runId: "r-billing",
  });
  assert.deepEqual(entry.content.体験ブロック, { status: "記録済み", count: 2 });
});

test("keeps a missing Augur ledger and evidence visibly unverified", () => {
  const entry = reviewReportEntry("tests", { ci: [{ name: "unit", status: "passed" }] });
  assert.equal(entry.content.動作ブロック.status, "台帳未整備");
  assert.equal(entry.content.体験ブロック.status, "未確認");
});

test("starts a distinct report for a same-head retry and redacts report text", () => {
  const first = createReviewReport({ attemptId: ATTEMPT, headSha: HEAD, at: AT });
  const retry = updateReviewReport(first, {
    id: "final", kind: "outcome", label: "Outcome", status: "failed", at: AT,
    content: SECRET_LINE,
  }, { attemptId: "job-2", headSha: HEAD });
  assert.equal(retry.attemptId, "job-2");
  assert.equal(retry.entries.length, 1);
  assert.match(retry.entries[0].content, /redacted/);
});

test("keeps the reviewer's own text in the review stage and in the final outcome", () => {
  const reviewerOutput = redactedReviewerOutput(`Looks correct.\n${SECRET_LINE}\nNo blockers.`);
  const report = updateReviewReport(createReviewReport({ attemptId: ATTEMPT, headSha: HEAD, at: AT }), {
    id: "stage:review",
    ...reviewReportEntry("review", { reviewer: "codex-sol", plan: null, reviewerOutput }),
    status: "passed",
    at: AT,
  });
  const stored = JSON.parse(report.entries.at(-1).content);
  assert.match(stored.reviewerOutput, /^Looks correct\.\n\[redacted: [^\]]+\]\nNo blockers\.$/);

  const final = finalReviewReportEntry({ conclusion: "success", reviewer: "codex-sol", reviewerOutput, reusedStages: ["tests"] });
  assert.equal(final.content.reviewerOutput, reviewerOutput);
  assert.deepEqual(final.content.reusedStages, ["tests"]);
});

test("records a missing review text as null instead of inventing one", () => {
  assert.equal(redactedReviewerOutput(""), null);
  assert.equal(redactedReviewerOutput("   \n"), null);
  assert.equal(redactedReviewerOutput(undefined), null);
  assert.equal(finalReviewReportEntry({ conclusion: "success", reviewer: "skipped" }).content.reviewerOutput, null);
});

test("masks a secret inside structured content without breaking the JSON", () => {
  const report = updateReviewReport(null, {
    id: "final",
    ...finalReviewReportEntry({ conclusion: "action_required", reasons: [SECRET_LINE, "Tests failed"] }),
    at: AT,
  }, { attemptId: ATTEMPT, headSha: HEAD });
  const content = JSON.parse(report.entries[0].content);
  assert.equal(content.conclusion, "action_required");
  assert.match(content.reasons[0], /redacted/);
  assert.equal(content.reasons[1], "Tests failed");
  assert.doesNotMatch(report.entries[0].content, /abcdefghijklmnopqrstuvwxyz012345/);
});

test("a re-review clears the previous review text unless it reuses that model review", () => {
  assert.equal(pendingReviewProjection().reviewerOutput, null);
  const previous = { reviewer: "codex-sol", reviewPlan: null, reviewerOutput: "LGTM" };
  assert.equal(retainedStageProjection(previous, ["review"]).reviewerOutput, "LGTM");
  assert.equal("reviewerOutput" in retainedStageProjection(previous, ["tests"]), false);
});
