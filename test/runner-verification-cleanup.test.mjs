import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createPrReviewRunner } from "../src/runner.mjs";

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
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
