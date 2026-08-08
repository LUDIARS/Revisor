import { analyzePr, ensureInitialAnalysis } from "./anatomia.mjs";
import { runPlannedTests } from "./ci.mjs";
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
      return review(options);
    case REVIEW_WORK_STAGES.SECURITY:
      return security(options);
    default:
      throw new Error(`Unsupported review work stage '${work.stage}'.`);
  }
}
