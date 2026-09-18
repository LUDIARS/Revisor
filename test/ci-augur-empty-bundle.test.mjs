import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPlannedTests, testsPassed } from "../src/ci.mjs";

test("treats Augur's --for-revisor empty-bundle answer as a skipped domain, not a runner error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-augur-empty-"));
  try {
    mkdirSync(join(directory, ".augur"));
    writeFileSync(join(directory, ".augur", "tests.jsonl"), "{}\n");
    const augurFolder = join(directory, "augur");
    mkdirSync(join(augurFolder, "bin"), { recursive: true });
    writeFileSync(join(augurFolder, "bin", "augur.mjs"), "");
    const results = await runPlannedTests({
      worktreePath: directory,
      testCases: [{ name: "test", command: "npm", args: ["test"], cwd: ".", timeoutMs: 1 }],
      plan: { testSelection: { selected: ["test"], skipped: [] } },
      targetDomains: ["governance", "broken"],
      augurFolder,
      execute: async (options) => options.args.includes("domain:governance")
        ? { ok: true, exitCode: 0, stdout: '{"empty":true,"message":"no registered tests"}\n', stderr: "" }
        : { ok: true, exitCode: 0, stdout: '{"unexpected":true}', stderr: "" },
    });
    const byDomain = Object.fromEntries(results.filter((item) => item.domain).map((item) => [item.domain, item]));
    assert.equal(byDomain.governance.status, "skipped");
    assert.equal(byDomain.governance.reason, "governance に登録テストが無い");
    assert.equal(byDomain.broken.status, "error");
    assert.equal(testsPassed(results.filter((item) => item.domain !== "broken")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
