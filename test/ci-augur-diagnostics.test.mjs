import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runPlannedTests } from "../src/ci.mjs";
import { captureFailedTestOutput } from "../src/test-output.mjs";

test("Augur errors retain bounded redacted diagnostics; passes and empty bundles do not", async () => {
  const root = mkdtempSync(join(tmpdir(), "rv-augur-diagnostics-"));
  try {
    mkdirSync(join(root, ".augur")); writeFileSync(join(root, ".augur/tests.jsonl"), "{}\n");
    const augurFolder = join(root, "augur"); mkdirSync(join(augurFolder, "bin"), { recursive: true });
    writeFileSync(join(augurFolder, "bin/augur.mjs"), "");
    const failed = { ok: false, exitCode: 2, stdout: "", stderr: "error: database is locked\n" };
    const responses = {
      missing: failed,
      passed: { ok: true, exitCode: 0, stdout: JSON.stringify({ runId: "r-pass", status: "passed", summary: { total: 1, passed: 1, failed: 0 } }), stderr: "do not retain" },
      empty: { ok: true, exitCode: 0, stdout: '{"empty":true}', stderr: "do not retain" },
      failed: { ok: false, exitCode: 1, stdout: JSON.stringify({ runId: "r-fail", status: "failed", summary: { total: 1, passed: 0, failed: 1 } }), stderr: "assertion failed" },
    };
    const results = await runPlannedTests({ worktreePath: root, augurFolder,
      testCases: [{ name: "unit", command: "node", args: [], cwd: "." }],
      plan: { testSelection: { selected: ["unit"], skipped: [] } }, targetDomains: Object.keys(responses),
      execute: async ({ args }) => responses[args[args.indexOf("--bundle") + 1].slice(7)],
    });
    assert.equal(results[0].status, "error"); assert.equal(results[0].runId, null);
    assert.deepEqual(results[0].output, captureFailedTestOutput(failed));
    assert.equal(results[1].output, undefined); assert.equal(results[2].output, undefined);
    assert.equal(results[3].status, "failed"); assert.match(results[3].output.text, /assertion failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
