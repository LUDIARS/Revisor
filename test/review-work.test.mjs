import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_WORK_STAGES, runReviewWork } from "../src/review-work.mjs";

test("runs exactly the requested review stage", async () => {
  const invoked = [];
  const executors = {
    analyze: async (options) => { invoked.push(["anatomia", options]); return "analysis"; },
    initialAnalyze: async (options) => { invoked.push(["initial", options]); return "initial"; },
    runTests: async (options) => { invoked.push(["tests", options]); return "tests"; },
    review: async (options) => { invoked.push(["review", options]); return "review"; },
    security: async (options) => { invoked.push(["security", options]); return "security"; },
    forcedReviewModel: () => "",
    forcedReviewEffort: () => "",
  };
  const cases = [
    [REVIEW_WORK_STAGES.ANALYZE, "analysis", "anatomia"],
    [REVIEW_WORK_STAGES.INITIAL_ANALYZE, "initial", "initial"],
    [REVIEW_WORK_STAGES.TEST, "tests", "tests"],
    [REVIEW_WORK_STAGES.REVIEW, "review", "review"],
    [REVIEW_WORK_STAGES.SECURITY, "security", "security"],
  ];

  for (const [stage, result, executor] of cases) {
    const options = { stage };
    assert.equal(await runReviewWork({ stage, options }, executors), result);
    // Model overrides and per-case progress callbacks are added only at their owning stage.
    const expected = stage === REVIEW_WORK_STAGES.REVIEW
      ? { forcedModel: "", forcedEffort: "", ...options }
      : options;
    const [actualExecutor, actualOptions] = invoked.pop();
    if (stage === REVIEW_WORK_STAGES.TEST) {
      const { onCheckStarted, onCheckResult, ...originalOptions } = actualOptions;
      assert.equal(typeof onCheckStarted, "function");
      assert.equal(typeof onCheckResult, "function");
      assert.deepEqual([actualExecutor, originalOptions], [executor, expected]);
    } else assert.deepEqual([actualExecutor, actualOptions], [executor, expected]);
  }
});

test("rejects incomplete or unknown review work", async () => {
  await assert.rejects(runReviewWork(null), /must be an object/);
  await assert.rejects(
    runReviewWork({ stage: "unknown", options: {} }),
    /Unsupported review work stage/,
  );
});
