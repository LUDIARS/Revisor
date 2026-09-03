import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createPrReviewRunner } from "../src/runner.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-verification-cleanup-"));
  const repoPath = join(directory, "Product");
  mkdirSync(join(directory, "Excubitor", "catalog"), { recursive: true });
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.mjs"), "export const version = \"base\";\n", "utf8");
  git(repoPath, "add", "product.mjs");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/verification");
  writeFileSync(join(repoPath, "product.mjs"), "export const version = \"feature\";\n", "utf8");
  git(repoPath, "add", "product.mjs");
  git(repoPath, "commit", "-m", "feature");
  const headSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "main");
  return { directory, repoPath, headSha };
}

function reviewEnvironment(fixture) {
  const anatomiaFolder = join(fixture.directory, "Anatomia");
  mkdirSync(join(anatomiaFolder, "bin"), { recursive: true });
  writeFileSync(join(anatomiaFolder, "bin", "anatomia.mjs"), "", "utf8");
  const configPath = join(fixture.directory, "revisor.config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    settings: { anatomiaFolder, concordiaContextEnabled: false },
    secrets: {},
  }), "utf8");
  return { ...process.env, REVISOR_CONFIG_PATH: configPath };
}

function analyzedChange(changedViolations = []) {
  return {
    domain: {
      hasTargetDomain: true,
      targetDomains: [{ name: "review-plan", changedAnchors: ["fn:changed"] }],
      unassignedAnchors: [],
    },
    quality: {
      changedFunctions: [{ anchor: "fn:changed" }],
      changedOrphans: [],
      complexity: { score: 100, functions: 1 },
    },
    architecture: { verify: { pass: true, gates: [] }, changedViolations },
  };
}

function previousReview(headSha) {
  return {
    reviewedHeadSha: headSha,
    intentReviewCompleted: true,
    reviewer: "codex-sol",
    leakage: { totalFindings: 0, findings: [] },
    ci: [{ name: "worktree-lifetime", status: "passed" }],
    security: { status: "passed", totalFindings: 0, findings: [] },
    anatomia: {
      domain: {
        hasTargetDomain: true,
        targetDomains: [{ name: "review-lifecycle", changedAnchors: ["fn:changed"] }],
        unassignedAnchors: [],
      },
      quality: {
        changedFunctions: [{ anchor: "fn:changed" }],
        changedOrphans: [],
        complexity: { score: 100 },
      },
      architecture: {
        verify: { pass: true, gates: [] },
        changedViolations: [],
      },
      baselineComplexityScore: 100,
    },
  };
}

test("verification keeps disposable worktrees until registered tests settle", async () => {
  const fixture = repositoryFixture();
  try {
    const env = {
      ...process.env,
      REVISOR_CONFIG_PATH: join(fixture.directory, "revisor.config.json"),
    };
    const runner = createPrReviewRunner({ cwd: fixture.repoPath, env });
    const result = await runner({
      repository: "LUDIARS/Product",
      headRepository: "LUDIARS/Product",
      number: 250,
      rootPath: fixture.repoPath,
      reviewRootPath: fixture.repoPath,
      headRef: "feat/verification",
      baseRef: "main",
      headSha: fixture.headSha,
      reviewMode: "verification",
      verificationTargets: ["tests"],
      previousReview: previousReview(fixture.headSha),
      testCases: [{
        name: "worktree-lifetime",
        command: "node",
        args: [
          "-e",
          "setTimeout(() => process.exit(require('node:fs').existsSync('.git') ? 0 : 1), 300)",
        ],
        cwd: ".",
        timeoutMs: 10_000,
      }],
    });

    assert.equal(result.ci.length, 1);
    assert.equal(result.ci[0].name, "worktree-lifetime");
    assert.equal(result.ci[0].status, "passed");
    assert.equal(result.ci[0].exitCode, 0);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("the Anatomia front gate blocks before review and exposes violation details", async () => {
  const fixture = repositoryFixture();
  let reviewCalls = 0;
  try {
    const env = reviewEnvironment(fixture);
    const runner = createPrReviewRunner({
      cwd: fixture.repoPath,
      env,
      analyze: async () => analyzedChange([
        { severity: "error", message: "forbidden dependency" },
      ]),
      runReview: async () => {
        reviewCalls += 1;
        throw new Error("review must not run when the front gate blocks");
      },
    });

    const result = await runner({
      repository: "LUDIARS/Product",
      headRepository: "LUDIARS/Product",
      number: 385,
      rootPath: fixture.repoPath,
      reviewRootPath: fixture.repoPath,
      headRef: "feat/verification",
      baseRef: "main",
      headSha: fixture.headSha,
      reviewMode: "full",
      testCases: [],
    });

    assert.equal(reviewCalls, 0);
    assert.equal(result.conclusion, "action_required");
    assert.equal(result.reviewer, "skipped");
    assert.ok(result.reasons.some((reason) => reason.includes("forbidden dependency")));
  } finally {
    removeFixture(fixture.directory);
  }
});

test("rechecks the front gate after registered-test autofix changes the diff", async () => {
  const fixture = repositoryFixture();
  let headAnalyses = 0;
  let reviewCalls = 0;
  let testRuns = 0;
  try {
    const env = reviewEnvironment(fixture);
    const runner = createPrReviewRunner({
      cwd: fixture.repoPath,
      env,
      analyze: async ({ base }) => {
        if (base === "HEAD") return analyzedChange();
        headAnalyses += 1;
        return headAnalyses === 1
          ? analyzedChange()
          : analyzedChange([{ severity: "error", message: "autofix dependency violation" }]);
      },
      initialAnalyze: async () => ({
        project: { id: "product" },
        analysis: { files: 1, functions: 1, cacheHit: false },
      }),
      runTests: async () => {
        testRuns += 1;
        return testRuns === 1
          ? [{ name: "unit", status: "failed", exitCode: 1, output: "expected fix" }]
          : [{ name: "unit", status: "passed", exitCode: 0 }];
      },
      runReview: async ({ cwd }) => {
        reviewCalls += 1;
        writeFileSync(join(cwd, "product.mjs"), "export const version = \"autofixed\";\n", "utf8");
        return { ok: true, stdout: "fixed registered test", stderr: "" };
      },
    });

    const result = await runner({
      repository: "LUDIARS/Product",
      headRepository: "LUDIARS/Product",
      number: 385,
      rootPath: fixture.repoPath,
      reviewRootPath: fixture.repoPath,
      headRef: "feat/verification",
      baseRef: "main",
      headSha: fixture.headSha,
      reviewMode: "full",
      testCases: [{
        name: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        timeoutMs: 10_000,
      }],
    });

    assert.equal(reviewCalls, 1, "only the narrow test autofix model may run");
    assert.equal(result.conclusion, "action_required");
    assert.ok(result.reasons.some((reason) => reason.includes("autofix dependency violation")));
    assert.equal(result.contextSource, "anatomia-review-gate-after-test-autofix");
  } finally {
    removeFixture(fixture.directory);
  }
});
