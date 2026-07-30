import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChange } from "../src/change-classification.mjs";
import { advisePlan, parseAdvisorResponse } from "../src/plan-advisor.mjs";
import { planReview, stageEnabled } from "../src/review-plan.mjs";

const REQUEST = {
  repository: "LUDIARS/Revisor",
  number: 7,
  testCases: [{ name: "unit" }],
};

function deterministicPlan(changedPaths) {
  return planReview({
    classification: classifyChange({ changedPaths, unifiedDiff: "" }),
    testCases: REQUEST.testCases,
  });
}

test("reads the last JSON object out of a chatty answer", () => {
  const value = parseAdvisorResponse([
    "考えました。まず {this is not json} を検討し、",
    'それから {"stages":[{"id":"security_review","run":false,"reason":"文章だけ"}]}',
    "を提案します。",
  ].join("\n"));
  assert.equal(value.stages[0].id, "security_review");
});

test("a closing brace inside a string does not end the object early", () => {
  const value = parseAdvisorResponse('{"reason":"} not the end","ok":true}');
  assert.equal(value.ok, true);
  assert.equal(value.reason, "} not the end");
});

test("an answer with no JSON object is rejected", () => {
  assert.throws(() => parseAdvisorResponse("no plan today"), /no JSON object/);
});

test("advisor none leaves the deterministic plan untouched", async () => {
  const plan = deterministicPlan(["README.md"]);
  assert.equal(await advisePlan({ advisor: "none", plan, request: REQUEST, testCases: REQUEST.testCases }), plan);
});

test("an unreachable Augur CLI falls back to the deterministic plan", async () => {
  const plan = await advisePlan({
    advisor: "augur",
    plan: deterministicPlan(["src/runner.mjs"]),
    request: REQUEST,
    testCases: REQUEST.testCases,
    cwd: process.cwd(),
    augurFolder: "",
  });
  assert.equal(plan.source, "deterministic");
  assert.match(plan.advisorError, /Augur folder is not configured/);
  assert.equal(stageEnabled(plan, "registered_tests"), true);
});

function augurFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-augur-"));
  mkdirSync(join(directory, "bin"), { recursive: true });
  writeFileSync(join(directory, "bin", "augur.mjs"), "// stub\n", "utf8");
  return directory;
}

test("an Augur answer narrows an inert change through the safety floor", async () => {
  const directory = augurFixture();
  let invocation = null;
  try {
    const plan = await advisePlan({
      advisor: "augur",
      plan: deterministicPlan(["README.md"]),
      request: REQUEST,
      testCases: REQUEST.testCases,
      cwd: process.cwd(),
      augurFolder: directory,
      execute: async (options) => {
        invocation = options;
        return {
          ok: true,
          stdout: JSON.stringify({
            stages: [
              { id: "security_review", run: false, reason: "文章だけの変更" },
              { id: "leakage_scan", run: false, reason: "不要" },
            ],
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    assert.equal(plan.source, "advised");
    assert.equal(stageEnabled(plan, "security_review"), false);
    assert.equal(stageEnabled(plan, "leakage_scan"), true);
    assert.equal(invocation.args[1], "review-plan");
    const payload = JSON.parse(invocation.stdin);
    assert.equal(payload.repository, "LUDIARS/Revisor");
    assert.deepEqual(payload.changeProfile.kinds, ["docs"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failing Augur CLI leaves the deterministic plan in force", async () => {
  const directory = augurFixture();
  try {
    const plan = await advisePlan({
      advisor: "augur",
      plan: deterministicPlan(["README.md"]),
      request: REQUEST,
      testCases: REQUEST.testCases,
      cwd: process.cwd(),
      augurFolder: directory,
      execute: async () => ({ ok: false, stdout: "", stderr: "boom", exitCode: 1 }),
    });
    assert.equal(plan.source, "deterministic");
    assert.match(plan.advisorError, /boom/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an external-model advisor is not invoked while leakage is outstanding", async () => {
  let invoked = false;
  const plan = await advisePlan({
    advisor: "reviewer",
    plan: deterministicPlan(["src/runner.mjs"]),
    request: REQUEST,
    testCases: REQUEST.testCases,
    cwd: process.cwd(),
    reviewer: "codex-sol",
    leakageClear: false,
    runReview: async () => {
      invoked = true;
      return { ok: true, stdout: "{}" };
    },
  });
  assert.equal(invoked, false);
  assert.equal(plan.source, "deterministic");
  assert.match(plan.advisorError, /情報流出候補/);
});

test("a model advisor plan is applied when the leakage scan is clean", async () => {
  let invocation = null;
  const plan = await advisePlan({
    advisor: "reviewer",
    plan: deterministicPlan(["README.md"]),
    request: REQUEST,
    testCases: REQUEST.testCases,
    cwd: process.cwd(),
    reviewer: "codex-sol",
    leakageClear: true,
    runReview: async (options) => {
      invocation = options;
      return {
        ok: true,
        stdout: '{"stages":[{"id":"anatomia_code_analysis","run":true,"reason":"コード例を含む"}]}',
      };
    },
  });
  assert.equal(plan.source, "advised");
  assert.equal(plan.advisor, "reviewer");
  assert.equal(stageEnabled(plan, "anatomia_code_analysis"), true);
  // The planner only reads: it must not hold write access to a worktree that is
  // committed after it runs.
  assert.equal(invocation.readOnly, true);
});
