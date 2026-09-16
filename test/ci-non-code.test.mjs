import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { classifyChange } from "../src/change-classification.mjs";
import { runPlannedTests, testsPassed } from "../src/ci.mjs";
import { applyAdvisedPlan, planReview, planVerification } from "../src/review-plan.mjs";
import { reviewBlockLines } from "../src/review-report.mjs";

const testCases = [{ name: "diff-check", command: "git", args: ["diff", "--check"], cwd: ".", always: true, timeoutMs: 1000 }];

function ledgerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "revisor-non-code-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".augur"));
  writeFileSync(join(root, ".augur", "tests.jsonl"), "{}\n");
  return root;
}

for (const path of ["README.md", ".augur/tests.jsonl", "package-lock.json"]) {
  test(`runs registered checks with a ledger for ${path}`, async (t) => {
    const worktreePath = ledgerFixture(t);
    const classification = classifyChange({ changedPaths: [path], unifiedDiff: "" });
    for (const makePlan of [planReview, planVerification]) {
      const plan = applyAdvisedPlan(makePlan({ classification, testCases }), { stages: [] });
      assert.equal(plan.changeProfile.codeDomainRequired, false);
      const invocations = [];
      const results = await runPlannedTests({
        worktreePath, testCases, plan, targetDomains: [],
        execute: async (options) => {
          invocations.push(options);
          return { ok: true, exitCode: 0, stdout: "", stderr: "" };
        },
      });
      assert.equal(invocations.length, 1);
      assert.deepEqual(invocations[0].args, ["diff", "--check"]);
      assert.equal(testsPassed(results), true);
      assert.equal(results[0].advisory, undefined);
      assert.match(reviewBlockLines(results)[0], /登録検査（コードドメイン不要）/);
    }
  });
}

test("missing code domains and legacy plans still fail before any test executes", async (t) => {
  const worktreePath = ledgerFixture(t);
  const codePlan = planReview({
    classification: classifyChange({ changedPaths: ["src/index.mjs"], unifiedDiff: "" }), testCases,
  });
  assert.equal(codePlan.changeProfile.codeDomainRequired, true);
  const legacyPlan = { ...codePlan, changeProfile: undefined };
  for (const plan of [codePlan, legacyPlan]) {
    const results = await runPlannedTests({
      worktreePath, testCases, plan, targetDomains: [],
      execute: async () => assert.fail("missing code domains must not run registered tests"),
    });
    assert.equal(results[0].status, "error");
    assert.equal(testsPassed(results), false);
    assert.match(reviewBlockLines(results)[0], /台帳あり・実行不能/);
  }
});

test("non-code registered failures still block and planned skips remain explicit", async (t) => {
  const worktreePath = ledgerFixture(t);
  const cases = [...testCases, { name: "code-only", kinds: ["code"] }];
  const plan = planReview({
    classification: classifyChange({ changedPaths: ["README.md"], unifiedDiff: "" }), testCases: cases,
  });
  const results = await runPlannedTests({
    worktreePath, testCases: cases, plan,
    execute: async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "invalid diff" }),
  });
  assert.deepEqual(results.map((entry) => entry.status), ["failed", "skipped"]);
  assert.match(results[1].reason, /担当しない/);
  assert.equal(testsPassed(results), false);
});

test("non-code classification does not replace a known domain bundle", async (t) => {
  const worktreePath = ledgerFixture(t);
  const augurFolder = join(worktreePath, "augur");
  mkdirSync(join(augurFolder, "bin"), { recursive: true });
  writeFileSync(join(augurFolder, "bin", "augur.mjs"), "");
  const plan = planReview({
    classification: classifyChange({ changedPaths: ["settings.json"], unifiedDiff: "" }), testCases,
  });
  const results = await runPlannedTests({
    worktreePath, testCases, plan, augurFolder, targetDomains: ["review-gate"],
    execute: async (options) => {
      assert.ok(options.args.includes("domain:review-gate"));
      return { ok: true, exitCode: 0, stdout: JSON.stringify({ runId: "r-gate", status: "passed", summary: { total: 1, passed: 1, failed: 0 } }) };
    },
  });
  assert.equal(results[0].domain, "review-gate");
  assert.equal(results[0].runId, "r-gate");
});
