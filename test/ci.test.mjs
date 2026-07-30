import assert from "node:assert/strict";
import test from "node:test";
import { runRegisteredTests, testsPassed } from "../src/ci.mjs";

test("keeps the output of a failed case and none of a passing one", async () => {
  const invocations = [];
  let clock = 100;
  const results = await runRegisteredTests({
    worktreePath: process.cwd(),
    testCases: [
      { name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 1_000 },
      { name: "check", command: "node", args: ["--check", "x"], cwd: ".", timeoutMs: 1_000 },
    ],
    now: () => (clock += 5),
    execute: async (options) => {
      invocations.push(options);
      return invocations.length === 1
        ? { ok: true, exitCode: 0, stdout: "secret output", stderr: "" }
        : { ok: false, exitCode: 1, stdout: "", stderr: "private log" };
    },
  });
  assert.deepEqual(results[0], { name: "unit", status: "passed", exitCode: 0, durationMs: 5 });
  assert.equal(results[0].output, undefined);
  assert.equal(JSON.stringify(results).includes("secret output"), false);
  assert.deepEqual(
    { ...results[1], output: undefined },
    { name: "check", status: "failed", exitCode: 1, durationMs: 5, output: undefined },
  );
  assert.equal(results[1].output.truncated, false);
  assert.match(results[1].output.text, /--- stderr ---\nprivate log/);
  assert.equal(testsPassed(results), false);
});
