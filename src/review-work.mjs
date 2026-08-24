import { analyzePr, ensureInitialAnalysis } from "./anatomia.mjs";
import { runPlannedTests } from "./ci.mjs";
import { configuredForcedReviewEffort } from "./forced-review-effort.mjs";
import { configuredForcedReviewModel } from "./forced-review-model.mjs";
import { runReviewer } from "./reviewer.mjs";
import { runSecurityScan } from "./security-scan.mjs";

export const REVIEW_WORK_STAGES = Object.freeze({
  ANALYZE: "anatomia",
  INITIAL_ANALYZE: "anatomia_initial",
  TEST: "registered_tests",
  REVIEW: "reviewer",
  SECURITY: "security",
});

/**
 * Execute exactly one review stage inside a dedicated child worker.
 *
 * The orchestration process owns worktree lifecycle and gate decisions; this
 * module owns only the expensive stage operation. Keeping that boundary narrow
 * makes stage queues independently schedulable without letting child workers
 * mutate queue or PR state.
 */
export async function runReviewWork(work, {
  analyze = analyzePr,
  initialAnalyze = ensureInitialAnalysis,
  runTests = runPlannedTests,
  review = runReviewer,
  security = runSecurityScan,
  forcedReviewModel = configuredForcedReviewModel,
  forcedReviewEffort = configuredForcedReviewEffort,
} = {}) {
  if (!work || typeof work !== "object") {
    throw new TypeError("Review work must be an object.");
  }
  const options = work.options;
  if (!options || typeof options !== "object") {
    throw new TypeError("Review work options must be an object.");
  }
  switch (work.stage) {
    case REVIEW_WORK_STAGES.ANALYZE:
      return analyze(options);
    case REVIEW_WORK_STAGES.INITIAL_ANALYZE:
      return initialAnalyze(options);
    case REVIEW_WORK_STAGES.TEST:
      return runTests(options);
    case REVIEW_WORK_STAGES.REVIEW:
      // 審査ステージはすべてここを通るので、強制モデルの解決はこの 1 箇所で
      // 済む。judge / investigator / test autofix / narrative / plan advisor の
      // どの経路も個別に設定を読まない。
      return review({
        forcedModel: forcedReviewModel(),
        forcedEffort: forcedReviewEffort(),
        ...options,
      });
    case REVIEW_WORK_STAGES.SECURITY:
      return security(options);
    default:
      throw new Error(`Unsupported review work stage '${work.stage}'.`);
  }
}
