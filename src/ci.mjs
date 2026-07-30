import { resolve, relative } from "node:path";
import { runProcess } from "./process.mjs";
import { selectedTestCases, skippedTestOutcomes } from "./review-plan.mjs";
import { captureFailedTestOutput } from "./test-output.mjs";

function testCwd(worktreePath, configuredCwd) {
  const path = resolve(worktreePath, configuredCwd);
  const fromRoot = relative(resolve(worktreePath), path);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    if (fromRoot.startsWith("..")) {
      throw new Error(`Test cwd escapes the review worktree: ${configuredCwd}`);
    }
  }
  return path;
}

function configuredProcess(test, cwd, env) {
  if (process.platform !== "win32") {
    return {
      command: test.command,
      args: test.args,
      cwd,
      timeoutMs: test.timeoutMs,
      env,
    };
  }
  return {
    command: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", test.command, ...test.args],
    cwd,
    timeoutMs: test.timeoutMs,
    env,
  };
}

export async function runRegisteredTests({
  worktreePath,
  testCases,
  env = process.env,
  execute = runProcess,
  now = () => Date.now(),
}) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("The repository has no registered test cases.");
  }
  const results = [];
  for (const test of testCases) {
    const startedAt = now();
    const result = await execute(configuredProcess(
      test,
      testCwd(worktreePath, test.cwd),
      env,
    ));
    const outcome = {
      name: test.name,
      status: result.ok ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: Math.max(0, now() - startedAt),
    };
    // A failure keeps its (redacted, tail-truncated) output: "1 registered test
    // case(s) failed" alone forces whoever reads the PR to re-run the whole suite
    // locally to learn what a machine already knew. A pass keeps nothing.
    if (!result.ok) {
      const output = captureFailedTestOutput(result);
      if (output) outcome.output = output;
    }
    results.push(outcome);
  }
  return results;
}

// Executes only the cases the review plan selected and records the rest as
// `skipped` with the reason, so the dashboard shows what was not run instead of
// a shorter list that reads like a smaller suite.
export async function runPlannedTests({
  worktreePath,
  testCases,
  plan,
  env = process.env,
  execute = runProcess,
  now = () => Date.now(),
}) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("The repository has no registered test cases.");
  }
  const selected = selectedTestCases(plan, testCases);
  const executed = selected.length > 0
    ? await runRegisteredTests({ worktreePath, testCases: selected, env, execute, now })
    : [];
  return [...executed, ...skippedTestOutcomes(plan)];
}

// A skipped case is not a failure: the plan decided the change does not need it.
// Only an actual failing run blocks. An empty result set is still not a pass —
// a repository always has at least one registered case, so nothing to report
// means the run did not happen rather than that it succeeded.
export function testsPassed(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((result) => result.status !== "failed");
}
