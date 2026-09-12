import assert from "node:assert/strict";
import test from "node:test";
import { createReviewReport, updateReviewReport } from "../src/review-report.mjs";

const ATTEMPT = "job-1";
const HEAD = "a".repeat(40);
const AT = "2026-09-12T00:00:00.000Z";

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

test("starts a distinct report for a same-head retry and redacts report text", () => {
  const first = createReviewReport({ attemptId: ATTEMPT, headSha: HEAD, at: AT });
  const retry = updateReviewReport(first, {
    id: "final", kind: "outcome", label: "Outcome", status: "failed", at: AT,
    content: "token=\"abcdefghijklmnopqrstuvwxyz012345\"",
  }, { attemptId: "job-2", headSha: HEAD });
  assert.equal(retry.attemptId, "job-2");
  assert.equal(retry.entries.length, 1);
  assert.match(retry.entries[0].content, /redacted/);
});
