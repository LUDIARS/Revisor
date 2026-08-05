import assert from "node:assert/strict";
import test from "node:test";
import { runReviewWithCapacityFallback } from "../src/runner.mjs";

test("the review executor is required explicitly", async () => {
  await assert.rejects(
    runReviewWithCapacityFallback({ reviewer: "codex-sol" }),
    /reviewer executor function is required/,
  );
});

test("capacity fallback executes the alternate reviewer", async () => {
  const reviewers = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "claude-opus",
    cwd: "E:/tmp/review",
    prompt: "review",
  }, async (options) => {
    reviewers.push(options.reviewer);
    return options.reviewer === "claude-opus"
      ? { ok: false, stdout: "usage limit", stderr: "" }
      : { ok: true, stdout: "ok", stderr: "" };
  });
  assert.deepEqual(reviewers, ["claude-opus", "codex-sol"]);
  assert.equal(result.ok, true);
  assert.equal(result.reviewer, "codex-sol");
});
