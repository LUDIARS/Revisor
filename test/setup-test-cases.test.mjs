import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPlannedTests, testsPassed } from "../src/ci.mjs";
import { setupTestCases } from "../src/setup-test-cases.mjs";

const registered = (name, ...args) => ({ name, command: "npm", args, cwd: ".", timeoutMs: 1 });

function augurRepository() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-setup-ci-"));
  mkdirSync(join(directory, ".augur"));
  writeFileSync(join(directory, ".augur", "tests.jsonl"), "{}\n");
  const augurFolder = join(directory, "augur");
  mkdirSync(join(augurFolder, "bin"), { recursive: true });
  writeFileSync(join(augurFolder, "bin", "augur.mjs"), "");
  return { directory, augurFolder };
}

function bundleDomain(options) {
  const selector = options.args.find((item) => typeof item === "string" && item.startsWith("domain:"));
  return selector ? selector.slice("domain:".length) : null;
}

const passedRecord = (domain) => JSON.stringify({
  runId: `r-${domain}`, status: "passed", durationMs: 5, summary: { total: 1, passed: 1, failed: 0 },
});

test("picks only the registered preparation steps, in registered order", () => {
  const cases = [
    registered("bootstrap", "run", "bootstrap"),
    registered("test", "test"),
    registered("install-dependencies", "ci"),
    registered("vestigium-install", "ci"),
    registered("submodules"),
    registered("configure-release"),
    registered("lint", "run", "lint"),
  ];
  assert.deepEqual(setupTestCases(cases).map((item) => item.name), ["bootstrap", "install-dependencies", "vestigium-install", "submodules"]);
  assert.deepEqual(setupTestCases(undefined), []);
});

test("runs the registered bootstrap before the Augur domain bundles", async () => {
  const { directory, augurFolder } = augurRepository();
  try {
    const order = [];
    const results = await runPlannedTests({
      worktreePath: directory,
      testCases: [registered("bootstrap", "run", "bootstrap"), registered("test", "test")],
      plan: { testSelection: { selected: ["bootstrap", "test"], skipped: [] } },
      targetDomains: ["billing"],
      augurFolder,
      execute: async (options) => {
        const domain = bundleDomain(options);
        order.push(domain ?? "setup");
        return domain
          ? { ok: true, exitCode: 0, stdout: passedRecord(domain), stderr: "" }
          : { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(order, ["setup", "billing"]);
    assert.deepEqual(results.filter((item) => item.setup).map((item) => [item.name, item.status]), [["bootstrap", "passed"]]);
    assert.equal(results.find((item) => item.domain === "billing").status, "passed");
    assert.equal(results.some((item) => item.name === "test"), false);
    assert.equal(testsPassed(results), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stops before the bundles when the preparation step fails", async () => {
  const { directory, augurFolder } = augurRepository();
  try {
    let bundleRuns = 0;
    const results = await runPlannedTests({
      worktreePath: directory,
      testCases: [registered("install", "ci"), registered("bootstrap", "run", "bootstrap")],
      plan: { testSelection: { selected: [], skipped: [] } },
      targetDomains: ["billing"],
      augurFolder,
      execute: async (options) => {
        if (bundleDomain(options)) bundleRuns += 1;
        return { ok: false, exitCode: 1, stdout: "", stderr: "npm ERR! network" };
      },
    });
    assert.equal(bundleRuns, 0);
    assert.deepEqual(results.map((item) => [item.name, item.status]), [["install", "failed"]]);
    assert.equal(testsPassed(results), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
