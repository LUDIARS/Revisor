import assert from "node:assert/strict";
import test from "node:test";
import { runSecurityScan, skippedSecurityScan } from "../src/security-scan.mjs";

const SETTINGS = {
  securityScanEnabled: true,
  securityFailOnSeverity: "high",
  securityMaxCostUsd: 5,
  securityScanEffort: "medium",
  securityScanModel: "",
};

// Stateless on purpose: a test that must observe a call records it with its own
// local override instead of a recorder shared by every test.
function scanOptions(result) {
  return {
    worktreePath: "C:/tmp/head",
    diffBase: "abc123",
    settings: SETTINGS,
    execute: async () => ({ ok: result.exitCode === 0, stdout: "", stderr: "", ...result }),
    makeOutputDir: async () => "C:/tmp/security-output",
    removeOutputDir: async () => {},
  };
}

// The exit-1 tests differ only in the report on stdout; funneling them here
// keeps each helper's fan-in under the repo's coupling percentile.
function reportScan(stdout) {
  return scanOptions({ exitCode: 1, stdout });
}

test("skips without invoking the CLI when disabled by settings", async () => {
  let executed = false;
  const outcome = await runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    settings: { ...SETTINGS, securityScanEnabled: false },
    execute: async () => {
      executed = true;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal(outcome.status, "skipped");
  assert.equal(outcome.reason, "disabled by settings");
  assert.equal(executed, false);
});

test("passes the diff target, effort, severity and cost cap to the CLI", async () => {
  const invocations = [];
  const removed = [];
  const outcome = await runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    execute: async (invocation) => {
      invocations.push(invocation);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    removeOutputDir: async (path) => {
      removed.push(path);
    },
  });
  assert.equal(outcome.status, "passed");
  const [invocation] = invocations;
  assert.equal(invocation.name, "codex-security");
  assert.deepEqual(invocation.args, [
    "scan",
    "C:/tmp/head",
    "--diff",
    "abc123",
    "--json",
    "--effort",
    "medium",
    "--auth",
    "chatgpt",
    "--output-dir",
    "C:/tmp/security-output",
    "--fail-on-severity",
    "high",
    "--max-cost",
    "5",
  ]);
  assert.deepEqual(removed, ["C:/tmp/security-output"]);
});

// effort を渡し忘れると CLI 既定の xhigh が黙って効き、 予算を先に食い潰して
// スキャンが未完了 (exit 2) になる。 明示されていることを固定する。
test("never lets the CLI fall back to its xhigh default effort", async () => {
  const invocations = [];
  await runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    settings: { ...SETTINGS, securityScanEffort: "low" },
    execute: async (invocation) => {
      invocations.push(invocation);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const { args } = invocations[0];
  const index = args.indexOf("--effort");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "low");
});

test("passes a configured model and omits the flag when unset", async () => {
  const withModel = [];
  await runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    settings: { ...SETTINGS, securityScanModel: "gpt-5.6-terra" },
    execute: async (invocation) => {
      withModel.push(invocation);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  const modelIndex = withModel[0].args.indexOf("--model");
  assert.notEqual(modelIndex, -1);
  assert.equal(withModel[0].args[modelIndex + 1], "gpt-5.6-terra");

  const withoutModel = [];
  await runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    execute: async (invocation) => {
      withoutModel.push(invocation);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  assert.equal(withoutModel[0].args.includes("--model"), false);
});

test("sanitizes findings to severity, rule, file and line only", async () => {
  const options = reportScan(JSON.stringify({
      findings: {
        findings: [
          {
            severity: "high",
            title: "SQL injection",
            file: "src/query.ts",
            line: 42,
            excerpt: "db.run(`SELECT ${input}`)",
            reproduction: "curl ...",
          },
          { severity: "critical", rule: "auth-bypass", location: { path: "src/routes.ts" } },
        ],
      },
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.status, "findings");
  assert.equal(outcome.totalFindings, 2);
  assert.deepEqual(outcome.findings, [
    { severity: "high", rule: "SQL injection", file: "src/query.ts", line: 42 },
    { severity: "critical", rule: "auth-bypass", file: "src/routes.ts", line: null },
  ]);
  assert.equal(JSON.stringify(outcome).includes("SELECT"), false);
  assert.equal(JSON.stringify(outcome).includes("curl"), false);
});

test("still blocks when findings output cannot be parsed", async () => {
  const options = reportScan("not json");
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.status, "findings");
  assert.equal(outcome.totalFindings, 1);
  assert.deepEqual(outcome.findings, []);
  // The count is a floor, so the blocking explanation must say the report was
  // unread instead of claiming one measured finding.
  assert.equal(outcome.reason, "the scan report could not be read");
});

test("caps retained finding text so a report cannot smuggle an excerpt", async () => {
  const options = reportScan(JSON.stringify({
      findings: [{ severity: "high", rule: "x".repeat(5_000), file: "y".repeat(5_000) }],
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.findings[0].rule.length, 200);
  assert.equal(outcome.findings[0].file.length, 200);
});

test("reports the untruncated total while retaining bounded findings", async () => {
  const options = reportScan(JSON.stringify({
      findings: Array.from({ length: 150 }, (unused, index) => ({
        severity: "high",
        rule: `rule-${index}`,
        file: "src/app.ts",
        line: index + 1,
      })),
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.totalFindings, 150);
  assert.equal(outcome.findings.length, 100);
  assert.equal(outcome.findings.at(-1).rule, "rule-99");
});

test("counts only the findings at or above the configured severity", async () => {
  const options = reportScan(JSON.stringify({
      findings: [
        { severity: "critical", rule: "auth-bypass", file: "src/a.ts", line: 1 },
        { severity: "high", rule: "injection", file: "src/b.ts", line: 2 },
        { severity: "medium", rule: "weak-hash", file: "src/c.ts", line: 3 },
        { severity: "low", rule: "verbose-error", file: "src/d.ts", line: 4 },
        // An unranked severity is kept: the run already blocks, and dropping
        // what cannot be compared would understate the block.
        { severity: "unusual", rule: "unknown-scale", file: "src/e.ts", line: 5 },
      ],
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.totalFindings, 3);
  assert.deepEqual(outcome.findings.map((finding) => finding.rule), [
    "auth-bypass",
    "injection",
    "unknown-scale",
  ]);
  assert.equal(outcome.reason, null);
});

test("ranks severities case-insensitively and never through inherited keys", async () => {
  const options = reportScan(JSON.stringify({
      findings: [
        { severity: "HIGH", rule: "injection", file: "src/b.ts", line: 2 },
        { severity: "Low", rule: "verbose-error", file: "src/d.ts", line: 4 },
        // A severity that names an Object.prototype member must still be ranked
        // as unknown — and therefore kept — rather than resolving to a function.
        { severity: "constructor", rule: "odd-scale", file: "src/e.ts", line: 5 },
      ],
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.totalFindings, 2);
  assert.deepEqual(outcome.findings.map((finding) => finding.rule), [
    "injection",
    "odd-scale",
  ]);
});

test("names the floor when the report holds only sub-threshold findings", async () => {
  const options = reportScan(JSON.stringify({
      findings: [{ severity: "low", rule: "verbose-error", file: "src/d.ts", line: 4 }],
  }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.status, "findings");
  assert.equal(outcome.totalFindings, 1);
  assert.deepEqual(outcome.findings, []);
  assert.equal(
    outcome.reason,
    "the scan report listed no finding at or above the threshold",
  );
});

test("reports at least one finding when the report lists none", async () => {
  const options = reportScan(JSON.stringify({ findings: [] }));
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.status, "findings");
  assert.equal(outcome.totalFindings, 1);
  assert.equal(
    outcome.reason,
    "the scan report listed no finding at or above the threshold",
  );
});

test("reports an incomplete scan as an error without keeping stderr", async () => {
  const options = scanOptions({ exitCode: 2, stderr: "secret /home/user/.env leaked" });
  const outcome = await runSecurityScan(options);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.reason, "codex-security exited with code 2");
  assert.equal(JSON.stringify(outcome).includes(".env"), false);
});

test("reports a timeout or spawn failure as an error", async () => {
  const removed = [];
  const outcome = await runSecurityScan({
    ...scanOptions({ exitCode: null }),
    removeOutputDir: async (path) => {
      removed.push(path);
    },
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.reason, "codex-security did not finish (timeout or spawn failure)");
  assert.deepEqual(removed, ["C:/tmp/security-output"]);
});

test("removes the output directory when the CLI invocation throws", async () => {
  const removed = [];
  await assert.rejects(runSecurityScan({
    ...scanOptions({ exitCode: 0 }),
    execute: async () => {
      throw new Error("spawn EACCES");
    },
    removeOutputDir: async (path) => {
      removed.push(path);
    },
  }), /EACCES/);
  assert.deepEqual(removed, ["C:/tmp/security-output"]);
});

test("builds a stable skipped result", () => {
  assert.deepEqual(skippedSecurityScan("registered tests failed"), {
    status: "skipped",
    reason: "registered tests failed",
    failOnSeverity: null,
    totalFindings: 0,
    findings: [],
  });
});
