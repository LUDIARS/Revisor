import assert from "node:assert/strict";
import test from "node:test";
import { LocalPrReporter } from "../src/local-reporter.mjs";
import { retryReviewScope } from "../src/retry-review.mjs";
import { runPartialVerification } from "../src/runner.mjs";
import { classifyChange } from "../src/change-classification.mjs";

const UNIFIED_DIFF = [
  "diff --git a/product.mjs b/product.mjs",
  "--- a/product.mjs",
  "+++ b/product.mjs",
  "+export const version = 1;",
  "",
].join("\n");

function submittedChange() {
  return {
    unifiedDiff: UNIFIED_DIFF,
    classification: classifyChange({ changedPaths: ["product.mjs"], unifiedDiff: UNIFIED_DIFF }),
  };
}

const HEAD = "b".repeat(40);
const MOVED_HEAD = "c".repeat(40);

function analysisFixture() {
  return {
    domain: {
      hasTargetDomain: true,
      targetDomains: [{ name: "crash-recovery", changedAnchors: ["fn:changed"] }],
      unassignedAnchors: [],
    },
    quality: {
      changedFunctions: [{ anchor: "fn:changed" }],
      changedOrphans: [],
      complexity: { score: 100, functions: 1 },
    },
    architecture: { verify: { pass: true, gates: [] }, changedViolations: [] },
  };
}

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

// 審査の途中でプロセスが落ちた状況。 段階が通るたびにチェックポイントを書いてから、
// そこで落ちたものとして再投入の判定 (`retryReviewScope`) を見る。
async function reviewUpTo(stages, { headSha = HEAD } = {}) {
  const store = storeDouble({ checkStatus: "running", headSha, reasons: [] });
  const reporter = new LocalPrReporter(store);
  const payloads = {
    anatomia: { analysis: analysisFixture(), baselineComplexityScore: 100 },
    tests: { ci: [{ name: "unit", status: "passed", exitCode: 0 }] },
    review: { reviewer: "codex", plan: { source: "deterministic" } },
    security: { security: { status: "passed", totalFindings: 0, findings: [] } },
  };
  for (const stage of stages) {
    await reporter.reviewStageCompleted({ localPrId: "PR1", stage, headSha, ...payloads[stage] });
  }
  return store;
}

test("a stage checkpoint records the stage and its outcome without settling the review", async () => {
  const store = await reviewUpTo(["anatomia", "tests"]);

  assert.deepEqual(Object.keys(store.record.reviewStages).sort(), ["anatomia", "tests"]);
  assert.equal(store.record.reviewStages.tests.headSha, HEAD);
  assert.equal(store.record.reviewStages.tests.completed, true);
  assert.equal(store.record.ci[0].name, "unit");
  assert.ok(store.record.anatomia.domain);
  // 審査は終わっていない。 ここで test_ok にすると通っていない段階が通ったように見える。
  assert.equal(store.record.checkStatus, "running");
  // 審査を通り切ったヘッドはマージ判定が読む別の状態で、段階の通過では書かない。
  assert.equal(store.record.reviewedHeadSha, undefined);
});

test("a review interrupted before the model review still pays for it", async () => {
  const store = await reviewUpTo(["anatomia", "tests"]);

  assert.equal(retryReviewScope(store.record, HEAD).reviewMode, "full");
});

test("a review interrupted after each stage reruns only what is left", async () => {
  const afterReview = await reviewUpTo(["anatomia", "tests", "review"]);
  assert.deepEqual(retryReviewScope(afterReview.record, HEAD).verificationTargets, [
    "leakage",
    "security",
  ]);
  assert.deepEqual(retryReviewScope(afterReview.record, HEAD).reusedStages, [
    "anatomia",
    "tests",
    "review",
  ]);

  const afterSecurity = await reviewUpTo(["anatomia", "tests", "review", "security"]);
  assert.deepEqual(retryReviewScope(afterSecurity.record, HEAD).verificationTargets, ["leakage"]);

  // 段階の順序は問わない。 通ったものだけが積み上がる。
  const testsPending = await reviewUpTo(["anatomia", "review", "security"]);
  assert.deepEqual(retryReviewScope(testsPending.record, HEAD).verificationTargets, [
    "leakage",
    "tests",
  ]);
});

test("a moved head invalidates every stage", async () => {
  const store = await reviewUpTo(["anatomia", "tests", "review", "security"]);

  const scope = retryReviewScope(store.record, MOVED_HEAD);
  assert.equal(scope.reviewMode, "full");
  assert.deepEqual(scope.verificationTargets, []);
});

// 載せ替えで SHA だけ動いた場合は、提出側の patch-id 判定に従って引き継ぐ。
test("a re-landed head keeps its stages when the diff content is unchanged", async () => {
  const store = await reviewUpTo(["anatomia", "tests", "review", "security"]);

  const scope = retryReviewScope(store.record, MOVED_HEAD, { reviewedContentUnchanged: true });
  assert.equal(scope.reviewMode, "verification");
  assert.deepEqual(scope.verificationTargets, ["leakage"]);
  assert.equal(scope.reusedReview.matchedBy, "diff_content");
});

test("a checkpoint for another head or another job is ignored", async () => {
  const store = storeDouble({ checkStatus: "running", headSha: HEAD, jobId: "job-1" });
  const reporter = new LocalPrReporter(store);

  await reporter.reviewStageCompleted({
    localPrId: "PR1",
    jobId: "job-1",
    stage: "tests",
    headSha: MOVED_HEAD,
    ci: [{ name: "unit", status: "passed" }],
  });
  await reporter.reviewStageCompleted({
    localPrId: "PR1",
    jobId: "job-0",
    stage: "tests",
    headSha: HEAD,
    ci: [{ name: "unit", status: "passed" }],
  });

  assert.equal(store.record.reviewStages, undefined);
});

test("an unknown stage is refused rather than silently recorded", async () => {
  const store = storeDouble({ checkStatus: "running", headSha: HEAD });
  const reporter = new LocalPrReporter(store);

  await assert.rejects(
    () => reporter.reviewStageCompleted({ localPrId: "PR1", stage: "anatomia_initial", headSha: HEAD }),
    /Unknown review stage/,
  );
});

// 再投入された審査が、引き継いだ段階を本当に実行しないこと。 フラグだけ立てて
// 実行してしまえば節約にならず、逆に実行せずに通過を騙れば事故になる。
test("verification runs only the stages the scope asked for", async () => {
  const store = await reviewUpTo(["anatomia", "tests", "review", "security"]);
  const scope = retryReviewScope(store.record, HEAD);
  let testRuns = 0;
  const request = {
    repository: "LUDIARS/Product",
    number: 827,
    headSha: HEAD,
    testCases: [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 1000 }],
    reviewMode: scope.reviewMode,
    verificationTargets: scope.verificationTargets,
    reusedStages: scope.reusedStages,
    previousReview: store.record,
  };

  const result = await runPartialVerification({
    request,
    submitted: submittedChange(),
    settings: {},
    worktrees: { head: "unused", base: "unused", mergeBase: "unused" },
    anatomiaCliPath: null,
    env: {},
    runSecurity: async () => {
      throw new Error("a reused security stage must not run again");
    },
    complexityDropThreshold: 10,
    analyze: async () => {
      throw new Error("a reused Anatomia stage must not run again");
    },
    runTests: async () => {
      testRuns += 1;
      return [{ name: "unit", status: "passed", exitCode: 0 }];
    },
  });

  assert.equal(testRuns, 0, "the registered tests passed for this head already");
  assert.deepEqual(result.reusedStages, ["anatomia", "tests", "review", "security"]);
  assert.equal(result.intentReviewCompleted, true);
  assert.equal(result.ci[0].name, "unit");
});

test("verification reruns a stage that has not passed for this head", async () => {
  const store = await reviewUpTo(["anatomia", "review", "security"]);
  const scope = retryReviewScope(store.record, HEAD);
  let testRuns = 0;
  const checkpoints = [];

  const result = await runPartialVerification({
    request: {
      repository: "LUDIARS/Product",
      number: 827,
      headSha: HEAD,
      testCases: [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 1000 }],
      reviewMode: scope.reviewMode,
      verificationTargets: scope.verificationTargets,
      reusedStages: scope.reusedStages,
      previousReview: store.record,
    },
    submitted: submittedChange(),
    settings: {},
    worktrees: { head: "unused", base: "unused", mergeBase: "unused" },
    anatomiaCliPath: null,
    env: {},
    runSecurity: async () => {
      throw new Error("a reused security stage must not run again");
    },
    complexityDropThreshold: 10,
    analyze: async () => {
      throw new Error("a reused Anatomia stage must not run again");
    },
    runTests: async () => {
      testRuns += 1;
      return [{ name: "unit", status: "passed", exitCode: 0 }];
    },
    checkpoint: async (stage, payload) => checkpoints.push({ stage, payload }),
  });

  assert.equal(testRuns, 1);
  // やり直した段階も、通ったその場で記録する。 再検証も途中で落ちる。
  assert.deepEqual(checkpoints.map((entry) => entry.stage), ["tests"]);
  assert.deepEqual(result.reusedStages, ["anatomia", "review", "security"]);
});
