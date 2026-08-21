import assert from "node:assert/strict";
import test from "node:test";
import {
  alternateReviewer,
  reviewerCapacityUnavailable,
  reviewerForProvider,
  reviewerInvocation,
  runReviewer,
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

test("promotes a structured Claude rate limit to the capacity fallback signal", async () => {
  const sessionId = "4750bf36-ad78-48b3-9299-dbab7717bf9d";
  let invocation = null;
  const result = await runReviewer({
    reviewer: "claude-opus",
    cwd: "C:/work/review-head",
    prompt: "review",
    timeoutMs: 1000,
  }, {
    sessionIdFactory: () => sessionId,
    runCli: async (options) => {
      invocation = options;
      return { ok: false, stdout: "", stderr: "", exitCode: 1 };
    },
    detectClaudeCapacity: async (options) => {
      assert.deepEqual(options, { cwd: "C:/work/review-head", sessionId });
      return true;
    },
  });

  assert.deepEqual(invocation.args.slice(-3), ["--session-id", sessionId, "--print"]);
  assert.equal(reviewerCapacityUnavailable(result), true);
  assert.match(result.stderr, /rate_limit.*429/);
});

test("uses the fallback reviewer unless opposite-model review is enabled", () => {
  // 既定 (無効) では作成者の provider を見ない。実装委託が Claude 主体になり、
  // 反対モデル固定だとほぼ全 PR が codex-sol へ流れていた。
  for (const provider of ["claude", "codex", "gemini", undefined]) {
    assert.equal(reviewerForProvider(provider, "claude-opus"), "claude-opus");
    assert.equal(reviewerForProvider(provider, "codex-sol"), "codex-sol");
  }
  const opposite = { oppositeModelReviewEnabled: true };
  assert.equal(reviewerForProvider("claude", "claude-opus", opposite), "codex-sol");
  assert.equal(reviewerForProvider("codex", "codex-sol", opposite), "claude-opus");
  // 判別できない provider は有効時でも fallback のまま。
  assert.equal(reviewerForProvider("gemini", "claude-opus", opposite), "claude-opus");
});
