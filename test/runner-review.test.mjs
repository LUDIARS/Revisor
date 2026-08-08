import assert from "node:assert/strict";
import test from "node:test";
import { classifyChange } from "../src/change-classification.mjs";
import {
  runPartialVerification,
  runReviewWithCapacityFallback,
} from "../src/runner.mjs";

function passingAnalysis(score, functions = 1) {
  return {
    domain: {
      hasTargetDomain: true,
      targetDomains: [{ name: "review-plan", changedAnchors: ["fn:changed"] }],
      unassignedAnchors: [],
    },
    quality: {
      changedFunctions: [{ anchor: "fn:changed" }],
      changedOrphans: [],
      complexity: { score, functions },
    },
    architecture: {
      verify: { pass: true, gates: [] },
      changedViolations: [],
    },
  };
}

test("the review executor is required explicitly", async () => {
  await assert.rejects(
    runReviewWithCapacityFallback({ reviewer: "codex-sol" }),
    /reviewer executor function is required/,
  );
});

test("capacity fallback executes the alternate reviewer", async () => {
  const reviewers = [];
  const result = await runReviewWithCapacityFallback({
    reviewer: "claude-opus",
    cwd: "E:/tmp/review",
    prompt: "review",
  }, async (options) => {
    reviewers.push(options.reviewer);
    return options.reviewer === "claude-opus"
      ? { ok: false, stdout: "usage limit", stderr: "" }
      : { ok: true, stdout: "ok", stderr: "" };
  });
  assert.deepEqual(reviewers, ["claude-opus", "codex-sol"]);
  assert.equal(result.ok, true);
  assert.equal(result.reviewer, "codex-sol");
});

test("moved-head verification replans and refreshes head-dependent evidence", async () => {
  const previousAnalysis = passingAnalysis(90);
  const calls = [];
  const testCases = [{
    name: "unit",
    command: "node",
    args: ["--test"],
    cwd: ".",
    timeoutMs: 60_000,
  }];
  const result = await runPartialVerification({
    request: {
      repository: "LUDIARS/Revisor",
      number: 266,
      headSha: "b".repeat(40),
      reviewMode: "verification",
      verificationTargets: ["anatomia"],
      testCases,
      previousReview: {
        reviewedHeadSha: "a".repeat(40),
        intentReviewCompleted: true,
        reviewer: "codex-sol",
        reviewPlan: {
          source: "advised",
          stages: [
            { id: "registered_tests", run: false },
            { id: "anatomia_code_analysis", run: false },
            { id: "security_review", run: false },
          ],
          testSelection: { selected: [], skipped: [] },
        },
        anatomia: { ...previousAnalysis, baselineComplexityScore: 90 },
        leakage: { totalFindings: 0 },
        ci: [{ name: "unit", status: "passed" }],
        security: { status: "passed", totalFindings: 0 },
        runtimeVerification: { score: 100, required: true, factors: [], evidence: [] },
      },
    },
    submitted: {
      classification: classifyChange({
        changedPaths: ["src/runner.mjs"],
        unifiedDiff: "",
      }),
    },
    settings: { costValidationModeEnabled: false },
    worktrees: { head: "head-worktree", base: "base-worktree", mergeBase: "merge-base" },
    anatomiaCliPath: "anatomia-cli",
    env: {},
    runSecurity: async () => {
      throw new Error("security is not a target in this fixture");
    },
    complexityDropThreshold: 10,
    analyze: async (options) => {
      calls.push(options);
      return passingAnalysis(options.cwd === "base-worktree" ? 70 : 75);
    },
  });

  assert.deepEqual(calls.map(({ cwd, base }) => ({ cwd, base })), [
    { cwd: "head-worktree", base: "merge-base" },
    { cwd: "base-worktree", base: "HEAD" },
  ]);
  assert.equal(result.plan.source, "deterministic");
  assert.deepEqual(result.plan.testSelection.selected, ["unit"]);
  assert.equal(result.baselineComplexityScore, 70);
  assert.equal(result.complexityScoreDelta, 5);
  assert.equal(result.runtimeVerification.required, false);
});

test("does not treat Anatomia's neutral score as a complexity baseline", async () => {
  const testCases = [{
    name: "unit",
    command: "node",
    args: ["--test"],
    cwd: ".",
    timeoutMs: 60_000,
  }];
  const result = await runPartialVerification({
    request: {
      repository: "LUDIARS/Vultus",
      number: 330,
      headSha: "b".repeat(40),
      reviewMode: "verification",
      verificationTargets: ["anatomia"],
      testCases,
      previousReview: {
        reviewedHeadSha: "a".repeat(40),
        intentReviewCompleted: true,
        reviewer: "codex-sol",
        reviewPlan: {
          source: "deterministic",
          stages: [],
          testSelection: { selected: [], skipped: [] },
        },
        anatomia: {
          ...passingAnalysis(100, 0),
          baselineComplexityScore: 100,
          baselineComplexityFunctionCount: 0,
        },
        leakage: { totalFindings: 0 },
        ci: [{ name: "unit", status: "passed" }],
        security: { status: "passed", totalFindings: 0 },
        runtimeVerification: { score: 100, required: false, factors: [], evidence: [] },
      },
    },
    submitted: {
      classification: classifyChange({
        changedPaths: ["server/src/index.ts"],
        unifiedDiff: "",
      }),
    },
    settings: { costValidationModeEnabled: false },
    worktrees: { head: "head-worktree", base: "base-worktree", mergeBase: "merge-base" },
    anatomiaCliPath: "anatomia-cli",
    env: {},
    runSecurity: async () => {
      throw new Error("security is not a target in this fixture");
    },
    complexityDropThreshold: 10,
    analyze: async ({ cwd }) => cwd === "base-worktree"
      ? passingAnalysis(100, 0)
      : passingAnalysis(77, 454),
  });

  assert.equal(result.baselineComplexityScore, 100);
  assert.equal(result.baselineComplexityFunctionCount, 0);
  assert.equal(result.complexityScoreDelta, null);
  assert.deepEqual(result.reasons, []);
});
