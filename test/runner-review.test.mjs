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

test("does not compare against a persisted baseline without a function count", async () => {
  const result = await runPartialVerification({
    request: {
      repository: "LUDIARS/Revisor",
      number: 338,
      headSha: "b".repeat(40),
      reviewMode: "verification",
      verificationTargets: [],
      testCases: [],
      previousReview: {
        reviewedHeadSha: "a".repeat(40),
        intentReviewCompleted: true,
        reviewer: "codex-sol",
        anatomia: {
          ...passingAnalysis(85),
          baselineComplexityScore: 100,
        },
        leakage: { totalFindings: 0 },
        ci: [],
        security: { status: "passed", totalFindings: 0 },
        runtimeVerification: { score: 100, required: false, factors: [], evidence: [] },
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
  });

  assert.equal(result.baselineComplexityScore, 100);
  assert.equal(result.baselineComplexityFunctionCount, null);
  assert.equal(result.complexityScoreDelta, null);
  assert.deepEqual(result.reasons, []);
});

function verificationFixture({ ci, autofixTests, commitAutofix, analyze, settings, runSecurity }) {
  const testCases = [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 60_000 }];
  const classification = classifyChange({ changedPaths: ["server/src/index.ts"], unifiedDiff: "" });
  return runPartialVerification({
    request: {
      repository: "LUDIARS/Revisor",
      number: 926,
      headSha: "b".repeat(40),
      headRef: "feat/x",
      reviewMode: "verification",
      verificationTargets: ["tests"],
      testCases,
      previousReview: {
        reviewedHeadSha: "a".repeat(40),
        intentReviewCompleted: true,
        reviewer: "codex-sol",
        reviewPlan: { source: "deterministic", stages: [], testSelection: { selected: [], skipped: [] } },
        anatomia: { ...passingAnalysis(90), baselineComplexityScore: 90 },
        leakage: { totalFindings: 0 },
        ci: [{ name: "unit", status: "passed" }],
        security: { status: "passed", totalFindings: 0 },
        runtimeVerification: { score: 100, required: false, factors: [], evidence: [] },
      },
    },
    submitted: { classification, unifiedDiff: "" },
    settings: settings ?? { costValidationModeEnabled: false },
    worktrees: { head: "head-worktree", base: "base-worktree", mergeBase: "merge-base" },
    anatomiaCliPath: null,
    env: {},
    runSecurity: runSecurity ?? (async () => ({ status: "passed", totalFindings: 0 })),
    complexityDropThreshold: 10,
    analyze: analyze ?? (async () => passingAnalysis(90)),
    runTests: async () => ci,
    runReview: async () => ({ ok: true, stdout: "", stderr: "" }),
    repoPath: "repo",
    autofixTests,
    commitAutofix,
    readProfile: async () => ({ classification, unifiedDiff: "+ fixed" }),
    resolveCli: async () => "anatomia-cli",
  });
}

test("verification mode repairs failing registered tests with the bounded autofix", async () => {
  const calls = [];
  const result = await verificationFixture({
    ci: [{ name: "unit", status: "failed" }],
    autofixTests: async ({ initialCi }) => {
      calls.push("autofix");
      assert.equal(initialCi[0].status, "failed");
      return { ci: [{ name: "unit", status: "passed" }], status: "passed", reviewer: "codex-sol" };
    },
    commitAutofix: async () => {
      calls.push("commit");
      return "c".repeat(40);
    },
    analyze: async ({ cliPath, cwd }) => {
      calls.push(`analyze:${cwd}`);
      return passingAnalysis(90);
    },
  });
  assert.deepEqual(calls.slice(0, 2), ["autofix", "commit"]);
  assert.ok(calls.includes("analyze:head-worktree"), "anatomia is re-run on the repaired head");
  assert.equal(result.reviewedHeadSha, "c".repeat(40));
  assert.match(result.contextSource, /^partial-verification-after-test-autofix:/);
  assert.equal(result.humanQuestion, null);
  assert.deepEqual(result.reasons, []);
});

test("verification mode asks a human when the autofix cannot repair the tests", async () => {
  let committed = false;
  const result = await verificationFixture({
    ci: [{ name: "unit", status: "failed" }],
    autofixTests: async () => ({
      ci: [{ name: "unit", status: "failed" }],
      status: "exhausted",
      reviewer: "codex-sol",
    }),
    commitAutofix: async () => {
      committed = true;
      return "c".repeat(40);
    },
  });
  assert.equal(committed, false);
  assert.equal(result.reviewedHeadSha, "b".repeat(40));
  assert.match(result.humanQuestion, /still fail after the bounded automated autofix/);
  assert.ok(result.reasons.length > 0, "failed tests stay a blocking reason");
});

test("validation mode keeps the autofix model out of verification", async () => {
  let autofixCalled = false;
  const result = await verificationFixture({
    ci: [{ name: "unit", status: "failed" }],
    settings: { costValidationModeEnabled: true, costValidationSkipReview: true },
    autofixTests: async () => {
      autofixCalled = true;
      return { ci: [{ name: "unit", status: "passed" }], status: "passed", reviewer: "codex-sol" };
    },
    commitAutofix: async () => "c".repeat(40),
  });
  assert.equal(autofixCalled, false, "no review model runs while reviewer_autofix is skipped");
  assert.equal(result.reviewedHeadSha, "b".repeat(40));
  assert.match(result.contextSource, /^partial-verification:/);
  assert.ok(result.reasons.length > 0, "failed tests stay a blocking reason");
});

test("a repaired head re-runs the security scan instead of reusing the previous one", async () => {
  const scanned = [];
  const result = await verificationFixture({
    ci: [{ name: "unit", status: "failed" }],
    autofixTests: async () => ({
      ci: [{ name: "unit", status: "passed" }],
      status: "passed",
      reviewer: "codex-sol",
    }),
    commitAutofix: async () => "c".repeat(40),
    runSecurity: async () => {
      scanned.push("security");
      return { status: "passed", totalFindings: 0 };
    },
  });
  assert.deepEqual(scanned, ["security"], "the autofixed code is scanned, not the pre-fix code");
  assert.deepEqual(result.reasons, []);
});
