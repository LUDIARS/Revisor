import assert from "node:assert/strict";
import test from "node:test";
import {
  FORCEABLE_REVIEW_MODEL_IDS,
  configuredForcedReviewModel,
  forcedReviewerFor,
  isForcedReviewModel,
} from "../src/forced-review-model.mjs";
import {
  configuredForcedReviewEffort,
  isForcedReviewEffort,
} from "../src/forced-review-effort.mjs";
import { reviewerInvocation, runReviewer } from "../src/reviewer.mjs";
import { runReviewWithCapacityFallback } from "../src/runner.mjs";

test("accepts only the registered models, plus the empty opt-out", () => {
  assert.equal(isForcedReviewModel(""), true);
  for (const id of FORCEABLE_REVIEW_MODEL_IDS) {
    assert.equal(isForcedReviewModel(id), true);
  }
  assert.equal(isForcedReviewModel("opus-4"), false);
  assert.equal(isForcedReviewModel("claude-opus"), false);
  assert.equal(isForcedReviewModel(undefined), false);
});

test("resolves the reviewer family a forced model belongs to", () => {
  assert.equal(forcedReviewerFor("opus"), "claude-opus");
  assert.equal(forcedReviewerFor("gpt-5.6-sol"), "codex-sol");
  assert.equal(forcedReviewerFor(""), null);
  assert.equal(forcedReviewerFor("opus-4"), null);
});

// 補助モデルは審査に使わないと決めた以上、強制上書きの候補からも消えて
// いなければならない。 残っていると「しばらく全部このモデルで見る」の
// 一択でそれらを審査へ戻せてしまう。
test("refuses to force an auxiliary-only model", () => {
  assert.equal(isForcedReviewModel("sonnet"), false);
  assert.equal(isForcedReviewModel("gpt-5.6-terra"), false);
  assert.equal(forcedReviewerFor("sonnet"), null);
  assert.equal(forcedReviewerFor("gpt-5.6-terra"), null);
});

// Review stages run in child workers. An unreadable config there must leave
// installations that never asked for an override completely unaffected.
test("falls back to no override when the settings cannot be read", () => {
  assert.equal(configuredForcedReviewModel({}, () => { throw new Error("no config"); }), "");
  assert.equal(configuredForcedReviewModel({}, () => ({ forcedReviewModel: "bogus" })), "");
  assert.equal(configuredForcedReviewModel({}, () => ({})), "");
  assert.equal(configuredForcedReviewModel({}, () => ({ forcedReviewModel: "opus" })), "opus");
});

test("replaces the purpose-derived model on both reviewer families", () => {
  // 補助用途なら sonnet / terra が選ばれる呼び出しに強制をかける。 用途に
  // かかわらず強制が勝つことは、既定と違う側でしか確かめられない。
  assert.deepEqual(
    reviewerInvocation("claude-opus", { purpose: "auxiliary", forcedModel: "opus" }).args,
    ["--model", "opus", "--effort", "medium", "--permission-mode", "acceptEdits", "--print"],
  );
  assert.deepEqual(
    reviewerInvocation("codex-sol", { purpose: "auxiliary", forcedModel: "gpt-5.6-sol" }).args,
    [
      "exec", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=medium",
      "--sandbox", "workspace-write", "-",
    ],
  );
});

test("accepts only supported forced review efforts", () => {
  assert.equal(isForcedReviewEffort(""), true);
  assert.equal(isForcedReviewEffort("medium"), true);
  assert.equal(isForcedReviewEffort("xhigh"), false);
  assert.equal(configuredForcedReviewEffort({}, () => ({ forcedReviewEffort: "medium" })), "medium");
  assert.equal(configuredForcedReviewEffort({}, () => ({ forcedReviewEffort: "bogus" })), "");
});

test("forces medium effort even when the review strategy requested high", async () => {
  let invocation = null;
  await runReviewer({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "review",
    timeoutMs: 1000,
    effort: "high",
    forcedModel: "gpt-5.6-sol",
    forcedEffort: "medium",
  }, {
    runCli: async (options) => {
      invocation = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.ok(invocation.args.includes("model_reasoning_effort=medium"));
  assert.equal(invocation.args.includes("model_reasoning_effort=high"), false);
});

test("refuses a forced model that belongs to the other reviewer family", () => {
  assert.throws(
    () => reviewerInvocation("codex-sol", { forcedModel: "opus" }),
    /Forced review model 'opus' does not belong to reviewer 'codex-sol'/,
  );
});

test("leaves the purpose-derived model alone when nothing is forced", () => {
  assert.equal(reviewerInvocation("claude-opus", { forcedModel: "" }).args[1], "opus");
  assert.equal(
    reviewerInvocation("claude-opus", { purpose: "auxiliary", forcedModel: "" }).args[1],
    "sonnet",
  );
});

// runReviewer is the single choke point every review path funnels into, so the
// override has to hold even when the caller asked for the other family.
test("forces the reviewer family and model whatever the caller selected", async () => {
  let invocation = null;
  await runReviewer({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "review",
    timeoutMs: 1000,
    forcedModel: "opus",
  }, {
    sessionIdFactory: () => "1ea4a0c1-1d29-4d1f-9a1f-6b1a2f6d4c77",
    runCli: async (options) => {
      invocation = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal(invocation.name, "claude");
  assert.deepEqual(invocation.args, [
    "--model", "opus", "--effort", "medium", "--permission-mode", "acceptEdits",
    "--session-id", "1ea4a0c1-1d29-4d1f-9a1f-6b1a2f6d4c77", "--print",
  ]);
});

test("keeps the caller's reviewer when nothing is forced", async () => {
  let invocation = null;
  await runReviewer({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "review",
    timeoutMs: 1000,
    forcedModel: "",
  }, {
    runCli: async (options) => {
      invocation = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal(invocation.name, "codex");
  assert.equal(invocation.args[2], "gpt-5.6-sol");
});

test("reports the forced reviewer instead of the one selection asked for", async () => {
  const seen = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "review",
  }, async (options) => {
    seen.push(options.reviewer);
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }, { forcedModel: "opus" });
  assert.deepEqual(seen, ["claude-opus"]);
  assert.equal(result.reviewer, "claude-opus");
});

// Switching family on capacity failure would review with exactly the model the
// operator excluded, so the failure has to surface while a model is forced.
test("does not switch provider family on capacity failure while forced", async () => {
  const seen = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "claude-opus",
    cwd: "C:/work/head",
    prompt: "review",
  }, async (options) => {
    seen.push(options.reviewer);
    return { ok: false, stdout: "You've hit your monthly spend limit", stderr: "", exitCode: 1 };
  }, { forcedModel: "opus" });
  assert.deepEqual(seen, ["claude-opus"]);
  assert.equal(result.ok, false);
  assert.equal(result.reviewer, "claude-opus");
});

test("still switches provider family on capacity failure when nothing is forced", async () => {
  const seen = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "claude-opus",
    cwd: "C:/work/head",
    prompt: "review",
  }, async (options) => {
    seen.push(options.reviewer);
    return seen.length === 1
      ? { ok: false, stdout: "You've hit your monthly spend limit", stderr: "", exitCode: 1 }
      : { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }, { forcedModel: "" });
  assert.deepEqual(seen, ["claude-opus", "codex-sol"]);
  assert.equal(result.reviewer, "codex-sol");
});

// review-work is the one place that resolves the configured override, so the
// stage entry point is where "every review path is covered" has to be proven.
test("resolves the configured override once, at the review stage entry point", async () => {
  const { REVIEW_WORK_STAGES, runReviewWork } = await import("../src/review-work.mjs");
  let seen = null;
  await runReviewWork({
    stage: REVIEW_WORK_STAGES.REVIEW,
    options: { reviewer: "codex-sol", cwd: "C:/work/head", prompt: "review" },
  }, {
    forcedReviewModel: () => "opus",
    forcedReviewEffort: () => "medium",
    review: async (options) => {
      seen = options;
      return { ok: true };
    },
  });
  assert.equal(seen.forcedModel, "opus");
  assert.equal(seen.forcedEffort, "medium");
  assert.equal(seen.reviewer, "codex-sol");
});

test("lets an explicit option win over the configured override", async () => {
  const { REVIEW_WORK_STAGES, runReviewWork } = await import("../src/review-work.mjs");
  let seen = null;
  await runReviewWork({
    stage: REVIEW_WORK_STAGES.REVIEW,
    options: { reviewer: "codex-sol", cwd: "C:/work/head", prompt: "r", forcedModel: "" },
  }, {
    forcedReviewModel: () => "opus",
    forcedReviewEffort: () => "high",
    review: async (options) => {
      seen = options;
      return { ok: true };
    },
  });
  assert.equal(seen.forcedModel, "");
  assert.equal(seen.forcedEffort, "high");
});
