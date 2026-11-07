/**
 * @implements RV-NATIVE-DEPS-03 — the C++ dependency row ahead of the registered tests.
 *
 * Runs after the Praesidium preflight. A failing row does not stop the tests:
 * both are evidence, and `testsPassed` fails the stage on any row that is not
 * passed/skipped.
 *
 * SRP: placing the dependency row in the registered-check sequence.
 */
import { runNativeDependencyCheck } from "./native-deps/run.mjs";

/** @implements RV-NATIVE-DEPS-03 */
export async function runNativeDependencyCheckedTests(options, { check = runNativeDependencyCheck, runTests } = {}) {
  const result = await check(options);
  if (result) await options.onCheckResult?.(result);
  // Loaded lazily like the Praesidium wrapper does, so this module stays cheap to import.
  const executeTests = runTests ?? (await import("./ci.mjs")).runPlannedTests;
  const tests = await executeTests(options);
  return result ? [result, ...tests] : tests;
}
