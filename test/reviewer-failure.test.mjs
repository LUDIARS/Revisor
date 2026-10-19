import assert from "node:assert/strict";
import test from "node:test";
import { reviewerFailureError, reviewerFailureSummary } from "../src/reviewer-failure.mjs";

test("classifies failures without retaining provider output", () => {
  for (const [stderr, category] of [
    ["process timed out", "timeout"], ["HTTP 429 rate_limit", "capacity"],
    ["authentication failed HTTP 401", "authentication"],
    ["spawn tool ENOENT", "launch"], ["EACCES permission denied", "permission"],
    ["unrecognized failure", "unknown"],
  ]) {
    assert.deepEqual(reviewerFailureSummary("investigation", {
      reviewer: "claude-opus", exitCode: 1, stderr, stdout: "private repository text",
    }), { stage: "investigation", reviewer: "claude-opus", exitCode: 1, category });
  }
  assert.equal(reviewerFailureSummary("review", { stdout: "quota exceeded" }).category, "capacity");
});

test("arbitrary strings never reach logs or public errors", () => {
  const records = [];
  const error = reviewerFailureError("secret-stage", {
    reviewer: "secret-provider", exitCode: "secret-exit",
    stderr: "Authorization: Bearer private-value", stdout: "private prompt content",
  }, { log: (...args) => records.push(args) });
  assert.match(error.message, /stage=unknown; reviewer=unknown; category=unknown; exitCode=unknown/);
  assert.doesNotMatch(JSON.stringify(records) + error.message, /secret-|private-|prompt|Authorization/);
  assert.deepEqual(records[0][1], { stage: "unknown", reviewer: "unknown", exitCode: null, category: "unknown" });
});

test("log failure preserves both terminal review failures", () => {
  for (const stage of ["investigation", "review"]) {
    const error = reviewerFailureError(stage, { reviewer: "codex-sol", exitCode: 2 }, {
      log: () => { throw new Error("log unavailable"); },
    });
    assert.match(error.message, /failed; output was withheld/);
    assert.match(error.message, /reviewer=codex-sol; category=unknown; exitCode=2/);
  }
});
