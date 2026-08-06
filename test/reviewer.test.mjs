import assert from "node:assert/strict";
import test from "node:test";
import {
  alternateReviewer,
  reviewerCapacityUnavailable,
  reviewerInvocation,
} from "../src/reviewer.mjs";

test("uses the lower-cost model tier for both reviewer providers", () => {
  assert.deepEqual(reviewerInvocation("claude-opus"), {
    name: "claude",
    args: ["--model", "sonnet", "--effort", "medium", "--permission-mode", "acceptEdits", "--print"],
  });
  assert.deepEqual(reviewerInvocation("codex-sol"), {
    name: "codex",
    args: ["exec", "--model", "gpt-5.6-terra", "-c", "model_reasoning_effort=medium", "--sandbox", "workspace-write", "-"],
  });
});

test("falls back only for provider capacity failures", () => {
  assert.equal(alternateReviewer("claude-opus"), "codex-sol");
  assert.equal(alternateReviewer("codex-sol"), "claude-opus");
  assert.equal(reviewerCapacityUnavailable({
    ok: false,
    stdout: "You've hit your monthly spend limit",
  }), true);
  assert.equal(reviewerCapacityUnavailable({
    ok: false,
    stdout: "You've hit your limit · resets 5pm (Asia/Tokyo)",
  }), true);
  assert.equal(reviewerCapacityUnavailable({
    ok: false,
    exitCode: null,
    stderr: "process timed out",
  }), true);
  assert.equal(reviewerCapacityUnavailable({
    ok: false,
    stderr: "review command failed because the prompt is invalid",
  }), false);
});

test("keeps plan-only calls read-only on the lower-cost tier", () => {
  assert.deepEqual(reviewerInvocation("claude-opus", { readOnly: true }).args, [
    "--model", "sonnet", "--effort", "medium", "--permission-mode", "plan", "--print",
  ]);
  assert.deepEqual(reviewerInvocation("codex-sol", { readOnly: true }).args, [
    "exec", "--model", "gpt-5.6-terra", "-c", "model_reasoning_effort=medium", "--sandbox", "read-only", "-",
  ]);
});

test("uses Opus or Sol with high effort for the strong tier", () => {
  assert.deepEqual(
    reviewerInvocation("claude-opus", { tier: "strong", effort: "high" }).args,
    ["--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--print"],
  );
  assert.deepEqual(
    reviewerInvocation("codex-sol", { tier: "strong", effort: "high" }).args,
    ["exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=high", "--sandbox", "workspace-write", "-"],
  );
});
