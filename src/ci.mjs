import { resolve, relative } from "node:path";
import { runProcess } from "./process.mjs";

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
    results.push({
      name: test.name,
      status: result.ok ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: Math.max(0, now() - startedAt),
    });
  }
  return results;
}

export function testsPassed(results) {
  return results.length > 0 && results.every((result) => result.status === "passed");
}
