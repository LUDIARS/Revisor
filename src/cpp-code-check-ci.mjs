/**
 * @implements RV-CPP-CODE-CHECKS-03 — the C++ code checks as one registered-check row ahead of the tests.
 *
 * Runs after the Praesidium preflight and before the repository's registered
 * tests. A failing C++ check does not stop the tests: both verdicts are
 * evidence the reviewer reads, and `testsPassed` already fails the stage on any
 * non-passing row.
 *
 * SRP: placing the C++ check result in the registered-check sequence.
 */
import { runCppCodeChecks } from "./cpp-code-checks/run.mjs";

export async function runCppCheckedTests(options, { check = runCppCodeChecks, runTests } = {}) {
  const result = await check(options);
  if (result) await options.onCheckResult?.(result);
  // Loaded lazily like the Praesidium wrapper does, so this module stays cheap to import.
  // The C++ dependency vulnerability row (RV-NATIVE-DEPS-03) comes next, then the tests.
  const executeTests = runTests ?? (await import("./native-deps-ci.mjs")).runNativeDependencyCheckedTests;
  const tests = await executeTests(options);
  return result ? [result, ...tests] : tests;
}
