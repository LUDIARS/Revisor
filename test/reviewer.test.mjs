import assert from "node:assert/strict";
import test from "node:test";
import {
  alternateReviewer,
  modelForPurpose,
  reviewerCapacityUnavailable,
  reviewerForProvider,
  reviewerInvocation,
  runReviewer,
} from "../src/reviewer.mjs";

test("reviews with the strong model on both reviewer providers", () => {
  assert.deepEqual(reviewerInvocation("claude-opus"), {
    name: "claude",
    args: ["--model", "opus", "--effort", "medium", "--permission-mode", "acceptEdits", "--print"],
  });
  assert.deepEqual(reviewerInvocation("codex-sol"), {
    name: "codex",
    args: ["exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "--sandbox", "workspace-write", "-"],
  });
});

// 審査判断ではない機械作業 (test autofix / narrative) だけが安いモデルへ降りる。
// 既定を auxiliary 側にすると、purpose を渡し忘れた新しい審査経路が黙って
// 弱いモデルで走る — 既定は必ず review でなければならない。
test("uses the auxiliary model only for machine work", () => {
  assert.equal(reviewerInvocation("claude-opus", { purpose: "auxiliary" }).args[1], "sonnet");
  assert.equal(reviewerInvocation("codex-sol", { purpose: "auxiliary" }).args[2], "gpt-5.6-terra");
  assert.equal(modelForPurpose("claude-opus"), "opus");
  assert.equal(modelForPurpose("codex-sol"), "gpt-5.6-sol");
  assert.throws(() => modelForPurpose("gemini"), /Unsupported reviewer 'gemini'/);
  assert.throws(() => modelForPurpose("gemini", "auxiliary"), /Unsupported reviewer 'gemini'/);
  assert.throws(() => modelForPurpose("codex-sol", "auxilary"), /Unsupported reviewer purpose/);
  assert.throws(
    () => reviewerInvocation("codex-sol", { purpose: "auxilary", forcedModel: "gpt-5.6-sol" }),
    /Unsupported reviewer purpose/,
  );
});

test("REVISOR_CODEX_SANDBOX=danger-full-access drops the codex sandbox launch", () => {
  const env = { REVISOR_CODEX_SANDBOX: "danger-full-access" };
  assert.deepEqual(reviewerInvocation("codex-sol", { env, platform: "win32" }), {
    name: "codex",
    args: ["exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "--sandbox", "danger-full-access", "-"],
  });
  assert.deepEqual(reviewerInvocation("codex-sol", { readOnly: true, env, platform: "win32" }), {
    name: "codex",
    args: ["exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "--sandbox", "danger-full-access", "-"],
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

test("keeps plan-only calls read-only without downgrading the model", () => {
  assert.deepEqual(reviewerInvocation("claude-opus", { readOnly: true }).args, [
    "--model", "opus", "--effort", "medium", "--permission-mode", "plan", "--print",
  ]);
  assert.deepEqual(reviewerInvocation("codex-sol", { readOnly: true }).args, [
    "exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "--sandbox", "read-only", "-",
  ]);
});

test("carries the requested effort through to both reviewer providers", () => {
  assert.deepEqual(
    reviewerInvocation("claude-opus", { effort: "high" }).args,
    ["--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--print"],
  );
  assert.deepEqual(
    reviewerInvocation("codex-sol", { effort: "high" }).args,
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
  // オプションを渡さない呼び出しは作成者の provider を見ない。運用の既定
  // (defaults().oppositeModelReviewEnabled) は有効で、runner が明示的に渡す。
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
