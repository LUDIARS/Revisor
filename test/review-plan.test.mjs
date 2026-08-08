import assert from "node:assert/strict";
import test from "node:test";
import { classifyChange } from "../src/change-classification.mjs";
import {
  applyAdvisedPlan,
  applyCostValidationMode,
  planReview,
  planVerification,
  selectedTestCases,
  skippedTestOutcomes,
  stageEnabled,
} from "../src/review-plan.mjs";

const TEST_CASES = [
  { name: "unit", kinds: null, runtime: false, always: false },
  { name: "check", kinds: null, runtime: false, always: true },
  { name: "docs-lint", kinds: ["docs"], runtime: false, always: false },
  { name: "smoke", kinds: ["code"], runtime: true, always: false },
];

function planFor(changedPaths, testCases = TEST_CASES) {
  return planReview({
    classification: classifyChange({ changedPaths, unifiedDiff: "" }),
    testCases,
  });
}

test("a docs-only change drops code analysis and the vulnerability pass", () => {
  const plan = planFor(["README.md"]);
  assert.equal(stageEnabled(plan, "anatomia_code_analysis"), false);
  assert.equal(stageEnabled(plan, "security_review"), false);
  assert.equal(stageEnabled(plan, "anatomia_domain_review"), true);
  assert.equal(stageEnabled(plan, "spec_requirements"), true);
  assert.equal(stageEnabled(plan, "leakage_scan"), true);
  assert.equal(stageEnabled(plan, "reviewer_autofix"), true);
  assert.equal(plan.review.tier, "model_review");
  assert.match(plan.review.label, /モデルレビュー/);
});

test("cost validation mode records review, Genius and domain review as skipped", () => {
  const plan = applyCostValidationMode(planFor(["src/runner.mjs"]), true);
  assert.equal(stageEnabled(plan, "reviewer_autofix"), false);
  assert.equal(stageEnabled(plan, "anatomia_domain_review"), false);
  assert.equal(stageEnabled(plan, "genius_judgment"), false);
  assert.deepEqual(plan.validationMode.skipped, [
    "reviewer_autofix",
    "genius_judgment",
    "anatomia_domain_review",
  ]);
  assert.equal(plan.stages.find((stage) => stage.id === "reviewer_autofix").status, "skipped");
});

test("cost validation mode skips only the independently selected stage", () => {
  const plan = applyCostValidationMode(planFor(["src/runner.mjs"]), {
    costValidationSkipGenius: true,
  });
  assert.equal(stageEnabled(plan, "reviewer_autofix"), true);
  assert.equal(stageEnabled(plan, "anatomia_domain_review"), true);
  assert.equal(stageEnabled(plan, "genius_judgment"), false);
  assert.deepEqual(plan.validationMode.skipped, ["genius_judgment"]);
});

test("verification derives a deterministic plan from the current head", () => {
  const plan = planVerification({
    classification: classifyChange({
      changedPaths: ["src/runner.mjs"],
      unifiedDiff: "",
    }),
    testCases: TEST_CASES,
  });
  assert.equal(plan.source, "deterministic");
  assert.equal(stageEnabled(plan, "registered_tests"), true);
  assert.equal(stageEnabled(plan, "anatomia_code_analysis"), true);
  assert.equal(stageEnabled(plan, "security_review"), true);
  assert.deepEqual(plan.testSelection.selected.sort(), ["check", "smoke", "unit"]);
});

test("a spec change uses the same scale-selected model review tier", () => {
  const plan = planFor(["spec/feature/review-plan.md"]);
  assert.equal(plan.review.tier, "model_review");
  assert.match(plan.review.reason, /変更行数/);
});

test("a docs-only change runs only the test cases that declare docs coverage", () => {
  const plan = planFor(["README.md"]);
  assert.deepEqual(plan.testSelection.selected.sort(), ["check", "docs-lint"]);
  assert.deepEqual(
    plan.testSelection.skipped.map((entry) => entry.name).sort(),
    ["smoke", "unit"],
  );
  assert.deepEqual(
    selectedTestCases(plan, TEST_CASES).map((entry) => entry.name).sort(),
    ["check", "docs-lint"],
  );
  assert.deepEqual(
    skippedTestOutcomes(plan).map((entry) => entry.status),
    ["skipped", "skipped"],
  );
});

test("a code change keeps every check and every generic test case", () => {
  const plan = planFor(["src/runner.mjs"]);
  assert.equal(stageEnabled(plan, "anatomia_code_analysis"), true);
  assert.equal(stageEnabled(plan, "security_review"), true);
  assert.deepEqual(plan.testSelection.selected.sort(), ["check", "smoke", "unit"]);
  assert.deepEqual(plan.testSelection.skipped.map((entry) => entry.name), ["docs-lint"]);
});

test("registered_tests is off only when nothing covers the change", () => {
  const plan = planFor(["README.md"], [{ name: "unit", kinds: ["code"] }]);
  assert.equal(stageEnabled(plan, "registered_tests"), false);
  assert.deepEqual(plan.testSelection.selected, []);
});

test("an advisor cannot switch off a mandatory stage", () => {
  const plan = applyAdvisedPlan(planFor(["README.md"]), {
    advisor: "augur",
    stages: [
      { id: "leakage_scan", run: false, reason: "不要" },
      { id: "reviewer_autofix", run: false, reason: "不要" },
      { id: "anatomia_domain_review", run: false, reason: "不要" },
      { id: "spec_requirements", run: false, reason: "不要" },
    ],
  });
  for (const id of [
    "leakage_scan",
    "reviewer_autofix",
    "anatomia_domain_review",
    "spec_requirements",
  ]) {
    assert.equal(stageEnabled(plan, id), true, id);
  }
  assert.deepEqual(plan.advisedSkips, []);
});

test("an advisor cannot drop test coverage on executable change", () => {
  const plan = applyAdvisedPlan(planFor(["src/runner.mjs"]), {
    advisor: "reviewer",
    stages: [{ id: "registered_tests", run: false, reason: "小さい変更なので不要" }],
    testCases: [],
  });
  assert.equal(stageEnabled(plan, "registered_tests"), true);
  assert.deepEqual(plan.testSelection.selected.sort(), ["check", "smoke", "unit"]);
  assert.deepEqual(plan.advisedSkips, []);
});

test("an advisor may re-enable a deterministically skipped stage", () => {
  const plan = applyAdvisedPlan(planFor(["README.md"]), {
    advisor: "augur",
    stages: [{ id: "security_review", run: true, reason: "公開ドキュメントに秘匿情報が入りやすい" }],
  });
  assert.equal(stageEnabled(plan, "security_review"), true);
  assert.equal(plan.source, "advised");
  assert.equal(plan.advisor, "augur");
});

test("an advisor may narrow an inert change and the skip is recorded as risk", () => {
  const plan = applyAdvisedPlan(planFor(["README.md"]), {
    advisor: "augur",
    stages: [{ id: "registered_tests", run: false, reason: "文章だけの修正" }],
    testCases: [],
  });
  assert.equal(stageEnabled(plan, "registered_tests"), false);
  assert.deepEqual(plan.advisedSkips.map((entry) => entry.id), ["registered_tests"]);
});

test("an advisor cannot invent a test case that is not registered", () => {
  const plan = applyAdvisedPlan(planFor(["README.md"]), {
    advisor: "augur",
    testCases: ["unit", "not-registered"],
  });
  assert.equal(plan.testSelection.selected.includes("not-registered"), false);
  assert.equal(plan.testSelection.selected.includes("unit"), true);
});
