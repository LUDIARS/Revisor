import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { configuredProcess, runPlannedTests, runRegisteredTests, testsPassed } from "../src/ci.mjs";

test("keeps registered Git tests on the managed process boundary on Windows", () => {
  const options = configuredProcess(
    { command: "git", args: ["submodule", "update"], timeoutMs: 1_000 },
    "C:\\review",
    { ComSpec: "C:\\Windows\\cmd.exe" },
    "win32",
  );
  assert.equal(options.command, "git");
  assert.deepEqual(options.args, ["submodule", "update"]);

  const explicitPath = configuredProcess(
    { command: "C:\\desktop-client\\git.exe", args: ["status"], timeoutMs: 1_000 },
    "C:\\review",
    { ComSpec: "C:\\Windows\\cmd.exe" },
    "win32",
  );
  assert.equal(explicitPath.command, "C:\\desktop-client\\git.exe");
  assert.deepEqual(explicitPath.args, ["status"]);
});

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

function runRecord(domain, status = "passed") {
  return JSON.stringify({
    runId: `r-${domain}`, status, durationMs: 12,
    summary: { total: 3, passed: status === "passed" ? 3 : 2, failed: status === "failed" ? 1 : 0 },
  });
}

test("uses each changed Augur domain instead of the registered full suite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-augur-ci-"));
  try {
    mkdirSync(join(directory, ".augur"));
    writeFileSync(join(directory, ".augur", "tests.jsonl"), "{}\n");
    const augurFolder = join(directory, "augur");
    mkdirSync(join(augurFolder, "bin"), { recursive: true });
    writeFileSync(join(augurFolder, "bin", "augur.mjs"), "");
    const invocations = [];
    const results = await runPlannedTests({
      worktreePath: directory,
      testCases: [{ name: "whole-suite", command: "node", args: [], cwd: ".", timeoutMs: 1 }],
      plan: { testSelection: { selected: ["whole-suite"], skipped: [] } },
      targetDomains: [{ name: "billing" }, { name: "billing" }, { name: "orders" }],
      augurFolder,
      execute: async (options) => {
        invocations.push(options);
        const domain = options.args.find((item) => item.startsWith("domain:")).slice("domain:".length);
        return { ok: true, exitCode: 0, stdout: runRecord(domain), stderr: "" };
      },
    });
    assert.deepEqual(invocations.map((item) => item.args.at(-2)), ["--for-revisor", "--for-revisor"]);
    assert.deepEqual(results.map((item) => item.domain), ["billing", "orders"]);
    assert.equal(results.every((item) => item.status === "passed"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("records empty, failed, and runner-error Augur bundles without running fallback tests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-augur-ci-"));
  try {
    mkdirSync(join(directory, ".augur"));
    writeFileSync(join(directory, ".augur", "tests.jsonl"), "{}\n");
    const augurFolder = join(directory, "augur");
    mkdirSync(join(augurFolder, "bin"), { recursive: true });
    writeFileSync(join(augurFolder, "bin", "augur.mjs"), "");
    const execute = async (options) => {
      const domain = options.args.find((item) => item.startsWith("domain:")).slice("domain:".length);
      if (domain === "empty") return { ok: false, exitCode: 3, stdout: "", stderr: "" };
      if (domain === "failed") return { ok: false, exitCode: 1, stdout: runRecord(domain, "failed"), stderr: "" };
      return { ok: false, exitCode: 2, stdout: "broken output", stderr: "runner unavailable" };
    };
    const results = await runPlannedTests({
      worktreePath: directory,
      testCases: [{ name: "whole-suite", command: "node", args: [], cwd: ".", timeoutMs: 1 }],
      plan: { testSelection: { selected: ["whole-suite"], skipped: [] } },
      targetDomains: ["empty", "failed", "error"], augurFolder, execute,
    });
    assert.deepEqual(results.map((item) => item.status), ["skipped", "failed", "error"]);
    assert.equal(results[0].reason, "empty に登録テストが無い");
    assert.equal(testsPassed(results), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the selected registered suite when the repository has no Augur ledger", async () => {
  const results = await runPlannedTests({
    worktreePath: process.cwd(),
    testCases: [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 1 }],
    plan: { testSelection: { selected: ["unit"], skipped: [] } },
    execute: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
  });
  assert.deepEqual(results.map((item) => item.status), ["passed"]);
  assert.equal(results[0].advisory, "Augur 台帳未整備 (全体スイートを実行)");
});
