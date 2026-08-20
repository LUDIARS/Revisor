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
    // レビューステージだけは強制モデルの解決結果を足して渡す。
    // 他のステージは options をそのまま素通しする。
    const expected = stage === REVIEW_WORK_STAGES.REVIEW
      ? { forcedModel: "", ...options }
      : options;
    assert.deepEqual(invoked.pop(), [executor, expected]);
  }
});

test("rejects incomplete or unknown review work", async () => {
  await assert.rejects(runReviewWork(null), /must be an object/);
  await assert.rejects(
    runReviewWork({ stage: "unknown", options: {} }),
    /Unsupported review work stage/,
  );
});
