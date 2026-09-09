import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { selectAuxiliaryReviewer } from "../src/auxiliary-model-selection.mjs";
import { REVIEW_WORK_STAGES, runReviewWork } from "../src/review-work.mjs";
import { runReviewer } from "../src/reviewer.mjs";
import { runReviewWithCapacityFallback } from "../src/runner.mjs";
import { PrReviewWorkerPool } from "../src/worker-pool.mjs";

class FakeWorker extends EventEmitter {
  exitCode = null;
  signalCode = null;
  messages = [];
  pid = 12_345;

  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
  }

  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
  }
}

function reviewRequest(reviewer, purpose = "review") {
  return {
    stage: REVIEW_WORK_STAGES.REVIEW,
    localPrId: `${purpose}-${reviewer}`,
    options: { reviewer, purpose, effort: "low" },
  };
}

test("selects the less busy auxiliary family and prefers Terra on ties", () => {
  assert.equal(selectAuxiliaryReviewer([]), "codex-sol");
  assert.equal(selectAuxiliaryReviewer([
    reviewRequest("codex-sol"),
  ]), "claude-opus");
  assert.equal(selectAuxiliaryReviewer([
    reviewRequest("claude-opus"),
    reviewRequest("codex-sol"),
  ]), "codex-sol");
  assert.equal(selectAuxiliaryReviewer([
    reviewRequest("codex-sol", "auxiliary"),
    { stage: REVIEW_WORK_STAGES.TEST, options: { reviewer: "claude-opus" } },
  ]), "claude-opus");
  assert.equal(selectAuxiliaryReviewer([{
    ...reviewRequest("codex-sol"),
    options: { reviewer: "codex-sol", forcedModel: "opus" },
  }]), "codex-sol");
});

test("strips review overrides from auxiliary work at the worker boundary", async () => {
  let seen = null;
  await runReviewWork({
    stage: REVIEW_WORK_STAGES.REVIEW,
    options: {
      reviewer: "claude-opus",
      purpose: "auxiliary",
      forcedModel: "opus",
      forcedEffort: "high",
      effort: "low",
    },
  }, {
    forcedReviewModel: () => "gpt-5.6-sol",
    forcedReviewEffort: () => "medium",
    review: async (options) => {
      seen = options;
      return { ok: true };
    },
  });
  assert.equal(seen.forcedModel, "");
  assert.equal(seen.forcedEffort, "");
  assert.equal(seen.effort, "low");
});

test("tries the other auxiliary family once on capacity failure", async () => {
  const invocations = [];
  const logs = [];
  const result = await runReviewer({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "repair",
    timeoutMs: 1_000,
    purpose: "auxiliary",
    effort: "low",
    forcedModel: "opus",
    forcedEffort: "high",
  }, {
    log: (event, detail) => logs.push([event, detail]),
    sessionIdFactory: () => "1ea4a0c1-1d29-4d1f-9a1f-6b1a2f6d4c77",
    runCli: async (invocation) => {
      invocations.push(invocation);
      return invocations.length === 1
        ? { ok: false, stdout: "usage limit", stderr: "", exitCode: 1 }
        : { ok: true, stdout: "fixed", stderr: "", exitCode: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reviewer, "claude-opus");
  assert.deepEqual(invocations.map(({ name }) => name), ["codex", "claude"]);
  assert.ok(invocations[0].args.includes("gpt-5.6-terra"));
  assert.ok(invocations[0].args.includes("model_reasoning_effort=low"));
  assert.deepEqual(invocations[1].args.slice(0, 4), ["--model", "sonnet", "--effort", "low"]);
  assert.deepEqual(logs, [["auxiliary_model_capacity_fallback", {
    from: "codex-sol",
    to: "claude-opus",
  }]]);
});

test("does not retry ordinary auxiliary failures", async () => {
  let calls = 0;
  const logs = [];
  const result = await runReviewer({
    reviewer: "codex-sol",
    cwd: "C:/work/head",
    prompt: "repair",
    purpose: "auxiliary",
  }, {
    log: (...entry) => logs.push(entry),
    runCli: async () => {
      calls += 1;
      return { ok: false, stdout: "", stderr: "invalid prompt", exitCode: 1 };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reviewer, "codex-sol");
  assert.equal(calls, 1);
  assert.deepEqual(logs, []);
});

test("leaves the auxiliary retry to the reviewer executor", async () => {
  const seen = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "codex-sol",
    purpose: "auxiliary",
    forcedModel: "opus",
    forcedEffort: "high",
  }, async (options) => {
    seen.push(options);
    return { ok: false, reviewer: "claude-opus", stderr: "usage limit" };
  }, { forcedModel: "opus" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].forcedModel, "");
  assert.equal(seen[0].forcedEffort, "");
  assert.equal(result.reviewer, "claude-opus");
});

test("dispatch-time selection releases completed auxiliary work", async () => {
  const workers = [new FakeWorker(), new FakeWorker()];
  const available = [...workers];
  const pool = new PrReviewWorkerPool({
    size: 2,
    cwd: process.cwd(),
    forkWorker: () => available.shift(),
  });
  const strong = pool.run(reviewRequest("codex-sol"));
  const firstAuxiliary = pool.run(reviewRequest("codex-sol", "auxiliary"), {
    reviewLane: "fast",
  });
  const firstAuxiliaryWorker = workers.find((worker) =>
    worker.messages[0]?.request.options.purpose === "auxiliary");
  assert.equal(firstAuxiliaryWorker.messages[0].request.options.reviewer, "claude-opus");

  firstAuxiliaryWorker.emit("message", {
    type: "result",
    id: firstAuxiliaryWorker.messages[0].id,
    result: "first",
  });
  assert.equal(await firstAuxiliary, "first");
  const secondAuxiliary = pool.run(reviewRequest("codex-sol", "auxiliary"), {
    reviewLane: "fast",
  });
  assert.equal(firstAuxiliaryWorker.messages[1].request.options.reviewer, "claude-opus");
  firstAuxiliaryWorker.emit("message", {
    type: "result",
    id: firstAuxiliaryWorker.messages[1].id,
    result: "second",
  });
  const strongWorker = workers.find((worker) => worker !== firstAuxiliaryWorker);
  strongWorker.emit("message", {
    type: "result",
    id: strongWorker.messages[0].id,
    result: "strong",
  });
  assert.deepEqual(await Promise.all([strong, secondAuxiliary]), ["strong", "second"]);
  await pool.close();
});

test("dispatch-time selection releases auxiliary work when its worker fails", async () => {
  const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
  const available = [...workers];
  const pool = new PrReviewWorkerPool({
    size: 2,
    cwd: process.cwd(),
    forkWorker: () => available.shift(),
  });
  const strong = pool.run(reviewRequest("codex-sol"));
  const failed = pool.run(reviewRequest("codex-sol", "auxiliary"), { reviewLane: "fast" });
  const failedOutcome = failed.catch((error) => error.message);
  const queued = pool.run(reviewRequest("codex-sol", "auxiliary"), { reviewLane: "fast" });
  const failedWorker = workers.find((worker) =>
    worker.messages[0]?.request.options.purpose === "auxiliary");
  failedWorker.emit("error", new Error("worker failed"));

  assert.equal(await failedOutcome, "worker failed");
  assert.equal(workers[2].messages[0].request.options.reviewer, "claude-opus");
  workers[2].emit("message", {
    type: "result",
    id: workers[2].messages[0].id,
    result: "queued",
  });
  const strongWorker = workers.find((worker) =>
    worker.messages[0]?.request.options.purpose === "review");
  strongWorker.emit("message", {
    type: "result",
    id: strongWorker.messages[0].id,
    result: "strong",
  });
  assert.deepEqual(await Promise.all([strong, queued]), ["strong", "queued"]);
  await pool.close();
});
