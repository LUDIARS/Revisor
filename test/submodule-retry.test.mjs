import assert from "node:assert/strict";
import test from "node:test";
import { runRegisteredTests } from "../src/ci.mjs";

const SUBMODULES = {
  name: "submodules",
  command: "git.exe",
  args: ["submodule", "update", "--init", "--recursive"],
  cwd: ".",
  timeoutMs: 1_000,
};
const RESOLVER_FAILURE = {
  ok: false,
  exitCode: 1,
  stderr: "fatal: unable to access 'https://example.invalid/repo.git/': getaddrinfo() thread failed to start\n"
    + "Failed to clone 'lib/dep' a second time, aborting",
};

test("retries a Windows submodule resolver failure and reports one successful check", async () => {
  const events = [];
  const invocations = [];
  const result = await runRegisteredTests({
    worktreePath: process.cwd(),
    testCases: [SUBMODULES],
    platform: "win32",
    env: { SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", ComSpec: "cmd.exe", Path: "C:\\tools" },
    onCheckStarted: ({ name }) => events.push(`start:${name}`),
    onCheckResult: ({ status }) => events.push(`result:${status}`),
    execute: async (invocation) => {
      invocations.push(invocation);
      events.push("git");
      return invocations.length === 1 ? RESOLVER_FAILURE : { ok: true, exitCode: 0 };
    },
    wait: async (delay) => events.push(delay),
  });

  assert.deepEqual(events, ["start:submodules", "git", 2_000, "git", "result:passed"]);
  assert.equal(result[0].output, undefined);
  assert.deepEqual(invocations[1], invocations[0]);
  assert.deepEqual(invocations[0].env, {
    SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", ComSpec: "cmd.exe", Path: "C:\\tools",
  });
});

test("stops after two spaced retries and keeps the final failure output", async () => {
  const waits = [];
  let attempts = 0;
  const [result] = await runRegisteredTests({
    worktreePath: process.cwd(),
    testCases: [SUBMODULES],
    platform: "win32",
    execute: async () => ({ ...RESOLVER_FAILURE, stderr: `${RESOLVER_FAILURE.stderr}\nattempt ${++attempts}` }),
    wait: async (delay) => waits.push(delay),
  });

  assert.deepEqual(waits, [2_000, 8_000]);
  assert.equal(attempts, 3);
  assert.equal(result.status, "failed");
  assert.match(result.output.text, /attempt 3/);
});

for (const [label, platform, testCase, failure] of [
  ["a non-Windows failure", "linux", { ...SUBMODULES, command: "git" }, RESOLVER_FAILURE],
  ["an unrelated Git command", "win32", { ...SUBMODULES, args: ["fetch"] }, RESOLVER_FAILURE],
  ["an authentication failure", "win32", SUBMODULES, { ok: false, exitCode: 1, stderr: "Authentication failed" }],
  ["a timeout", "win32", SUBMODULES, { ...RESOLVER_FAILURE, exitCode: null }],
]) {
  test(`does not retry ${label}`, async () => {
    let attempts = 0;
    const [result] = await runRegisteredTests({
      worktreePath: process.cwd(),
      testCases: [testCase],
      platform,
      execute: async () => { attempts += 1; return failure; },
      wait: async () => assert.fail("unexpected retry"),
    });
    assert.equal(attempts, 1);
    assert.equal(result.status, "failed");
  });
}
