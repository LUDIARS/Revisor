import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTestAutofixPrompt,
  runTestAutofixLoop,
  isTestAutofixEnabled,
} from "../src/test-autofix.mjs";
import { applyCostValidationMode, planReview } from "../src/review-plan.mjs";

const failed = [{ name: "unit", status: "failed", exitCode: 1, output: "expected 1" }];
const passed = [{ name: "unit", status: "passed", exitCode: 0 }];

test("autofixes and reruns tests until they pass without invoking a review", async () => {
  let repairs = 0;
  let tests = 0;
  const result = await runTestAutofixLoop({
    initialCi: failed,
    repair: async () => ({ ok: true, changed: ++repairs < 3, stdout: `fix-${repairs}` }),
    runTests: async () => (++tests === 2 ? passed : failed),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(repairs, 2);
  assert.equal(tests, 2);
});

test("stops a no-progress autofix before it becomes a token loop", async () => {
  const result = await runTestAutofixLoop({
    initialCi: failed,
    repair: async () => ({ ok: true, changed: false, stdout: "no change" }),
    runTests: async () => {
      throw new Error("tests must not rerun without a change");
    },
  });
  assert.equal(result.status, "stalled");
  assert.equal(result.attempts, 1);
});

test("preserves registered-test evidence when the autofix model fails", async () => {
  let reranTests = false;
  const result = await runTestAutofixLoop({
    initialCi: failed,
    repair: async () => ({ ok: false, stdout: "withheld model output" }),
    runTests: async () => {
      reranTests = true;
      return passed;
    },
  });
  assert.equal(result.status, "model_failed");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.ci, failed);
  assert.deepEqual(result.outputs, []);
  assert.equal(reranTests, false);
});

test("withholds earlier reviewer output when a later autofix attempt fails", async () => {
  let repairs = 0;
  const result = await runTestAutofixLoop({
    initialCi: failed,
    repair: async () => {
      repairs += 1;
      return repairs === 1
        ? { ok: true, changed: true, stdout: "earlier reviewer output" }
        : { ok: false, stdout: "failed reviewer output" };
    },
    runTests: async () => failed,
  });
  assert.equal(result.status, "model_failed");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.ci, failed);
  assert.deepEqual(result.outputs, []);
});

test("the autofix prompt contains bounded failure evidence and forbids a general review", () => {
  const prompt = buildTestAutofixPrompt({
    request: { repository: "LUDIARS/Revisor", number: 1 },
    ci: failed,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.match(prompt, /expected 1/);
  assert.match(prompt, /Do not run repository code/);
  assert.match(prompt, /do not.*general review/i);
});

test("does not invoke test autofix when validation mode skips review models", () => {
  const plan = planReview({
    classification: {
      kinds: ["code"],
      counts: { code: 1 },
      changedFiles: 1,
      changedLines: 1,
      docsOnly: false,
      docsOrConfigOnly: false,
      touchesSpec: false,
      runtimeSurfaces: [],
    },
  });
  assert.equal(isTestAutofixEnabled(plan), true);
  assert.equal(isTestAutofixEnabled(applyCostValidationMode(plan, true)), false);
});
