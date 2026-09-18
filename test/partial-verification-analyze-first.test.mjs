import assert from "node:assert/strict";
import test from "node:test";
import { LocalPrReporter } from "../src/local-reporter.mjs";
import { retryReviewScope } from "../src/retry-review.mjs";
import { runPartialVerification } from "../src/runner.mjs";
import { classifyChange } from "../src/change-classification.mjs";

const HEAD = "d".repeat(40);
const UNIFIED_DIFF = [
  "diff --git a/product.mjs b/product.mjs",
  "--- a/product.mjs",
  "+++ b/product.mjs",
  "+export const version = 1;",
  "",
].join("\n");

function analysisFixture() {
  return {
    domain: {
      hasTargetDomain: true,
      targetDomains: [{ name: "harness-reliability", changedAnchors: ["fn:changed"] }],
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

// The model review passed, then the review died before its Anatomia stage was
// recorded — the state Cc #1893 was left in after a base merge.
async function reviewedWithoutAnatomia() {
  const record = { id: "PR1", checkStatus: "running", headSha: HEAD, reasons: [] };
  const reporter = new LocalPrReporter({
    updatePullRequest: (_id, patch) => Object.assign(record, patch),
    getPullRequest: () => record,
    appendPullRequestEvent() {},
  });
  await reporter.reviewStageCompleted({
    localPrId: "PR1", stage: "review", headSha: HEAD, reviewer: "codex", plan: { source: "deterministic" },
  });
  return record;
}

test("a partial verification without a previous Anatomia result analyses the head before selecting tests", async () => {
  const previous = await reviewedWithoutAnatomia();
  const scope = retryReviewScope(previous, HEAD);
  assert.equal(scope.reviewMode, "verification");
  assert.ok(scope.verificationTargets.includes("anatomia"));
  assert.ok(scope.verificationTargets.includes("tests"));

  let analyses = 0;
  let testDomains = null;
  const result = await runPartialVerification({
    request: {
      repository: "LUDIARS/Product",
      number: 1893,
      headSha: HEAD,
      testCases: [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 1000 }],
      reviewMode: scope.reviewMode,
      verificationTargets: scope.verificationTargets,
      reusedStages: scope.reusedStages,
      previousReview: previous,
    },
    submitted: {
      unifiedDiff: UNIFIED_DIFF,
      classification: classifyChange({ changedPaths: ["product.mjs"], unifiedDiff: UNIFIED_DIFF }),
    },
    settings: {},
    worktrees: { head: "head", base: "base", mergeBase: "merge-base" },
    anatomiaCliPath: "anatomia",
    env: {},
    runSecurity: async () => ({ status: "passed", totalFindings: 0, findings: [] }),
    complexityDropThreshold: 10,
    analyze: async ({ cwd }) => {
      if (cwd === "head") analyses += 1;
      return analysisFixture();
    },
    runTests: async ({ targetDomains }) => {
      testDomains = targetDomains;
      return [{ name: "unit", status: "passed", exitCode: 0 }];
    },
  });

  assert.deepEqual(testDomains.map((domain) => domain.name), ["harness-reliability"]);
  assert.equal(analyses, 1, "the head analysis is reused for the Anatomia stage, not run twice");
  assert.equal(result.ci[0].status, "passed");
});
