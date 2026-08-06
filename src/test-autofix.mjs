import { testsPassed } from "./ci.mjs";
import { stageEnabled } from "./review-plan.mjs";

export const DEFAULT_TEST_AUTOFIX_ATTEMPTS = 3;

export function isTestAutofixEnabled(plan) {
  return stageEnabled(plan, "reviewer_autofix");
}

export function buildTestAutofixPrompt({ request, ci, attempt, maxAttempts }) {
  const failures = ci
    .filter((outcome) => outcome.status === "failed")
    .map((outcome) => ({
      name: outcome.name,
      exitCode: outcome.exitCode,
      output: outcome.output ?? "(no captured output)",
    }));
  return [
    `Fix the failing registered tests for ${request.repository}#${request.number}.`,
    `This is autofix attempt ${attempt} of ${maxAttempts}.`,
    "Use only the failure evidence below. Make the smallest scoped source or test correction that restores the intended behaviour.",
    "You may read and edit files only. Do not run repository code, install dependencies, use network access, commit, push, or perform a general review; Revisor reruns the registered tests.",
    "Do not change a test merely to hide a real product defect.",
    `Failing tests (redacted and bounded):\n${JSON.stringify(failures, null, 2)}`,
  ].join("\n\n");
}

/**
 * Re-run narrowly prompted fixes until the registered tests pass. A hard cap
 * and no-progress stop prevent a broken test or environment from spawning an
 * unbounded model loop; callers can automatically start a fresh run only after
 * the underlying evidence changes.
 */
export async function runTestAutofixLoop({
  initialCi,
  repair,
  runTests,
  maxAttempts = DEFAULT_TEST_AUTOFIX_ATTEMPTS,
}) {
  let ci = initialCi;
  const outputs = [];
  for (let attempt = 1; !testsPassed(ci) && attempt <= maxAttempts; attempt += 1) {
    const result = await repair({ ci, attempt, maxAttempts });
    if (!result.ok) {
      // The model output stays withheld, but the registered-test evidence was
      // already redacted and bounded at capture time. Returning it lets the
      // normal action-required result persist the real failure instead of
      // replacing it with an infrastructure error that cannot be diagnosed.
      // A caller must never receive reviewer output with a model-failed
      // result, including output retained from an earlier successful attempt.
      return { ci, attempts: attempt, status: "model_failed", outputs: [] };
    }
    outputs.push(result.stdout ?? "");
    if (!result.changed) {
      return { ci, attempts: attempt, status: "stalled", outputs };
    }
    ci = await runTests();
  }
  return {
    ci,
    attempts: outputs.length,
    status: testsPassed(ci) ? "passed" : "exhausted",
    outputs,
  };
}
