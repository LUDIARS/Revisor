import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSecurePlannedTests } from "../src/praesidium-ci.mjs";

const CLI = fileURLToPath(new URL("../src/praesidium/cli.mjs", import.meta.url));

// A committed unit whose PR changes only its praesidium.json entry.
function reconfiguredRepository(t, source, entry, file = "a.cpp") {
  const root = mkdtempSync(join(tmpdir(), "praesidium-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  const config = (native) => JSON.stringify({ version: 1, native, web: [] });
  git("init", "--quiet");
  writeFileSync(join(root, file), source);
  writeFileSync(join(root, "praesidium.json"), config([{ file, standard: "c++20" }]));
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "praesidium.json"), config(entry ? [entry] : []));
  return { root, base };
}

function clangAvailable() {
  try { execFileSync("clang++", ["--version"], { stdio: "ignore", windowsHide: true }); return true; }
  catch { return false; }
}

function runCli(root, base) {
  const run = spawnSync(process.execPath, [CLI, "--repo", root, "--base", base], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  return { exitCode: run.status, report: JSON.parse(run.stdout) };
}

test("mandatory security result precedes every registered/Augur execution", async () => {
  const events = [];
  const outcomes = await runSecurePlannedTests({ worktreePath: "/fixture",
    onCheckStarted: async check => events.push(check.name),
    onCheckResult: async check => events.push(check.status),
  }, {
    scan: async () => ({ status: "passed", durationMs: 2 }),
    runTests: async () => { events.push("registered"); return [{ name: "unit", status: "passed" }]; },
  });
  assert.deepEqual(events, ["Praesidium security preflight", "passed", "registered"]);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].status, "passed");
  assert.equal(outcomes[1].name, "unit");
});

test("findings, unavailable scan and unknown results block before setup/install", async () => {
  for (const scan of [async () => ({ status: "failed" }), async () => ({ status: "error" }),
    async () => ({ status: "skipped" }), async () => null, async () => { throw new Error("unavailable"); }]) {
    const outcomes = await runSecurePlannedTests({ worktreePath: "/fixture" }, {
      scan, runTests: async () => { assert.fail("must not run setup or tests"); },
    });
    assert.ok(["failed", "error"].includes(outcomes[0].status));
    assert.equal(outcomes.length, 1);
  }
});

test("review merge base scopes the scan to changed paths and falls back when unknown", async () => {
  const seen = [];
  const scan = async (input) => { seen.push(input.changedPaths); return { status: "passed" }; };
  const runTests = async () => [];
  await runSecurePlannedTests({ worktreePath: "/fixture", mergeBase: "abc123" }, {
    scan, runTests, changes: (root, base) => { assert.deepEqual([root, base], ["/fixture", "abc123"]); return ["a.cpp"]; },
  });
  await runSecurePlannedTests({ worktreePath: "/fixture", mergeBase: "abc123" }, {
    scan, runTests, changes: () => { throw new Error("git unavailable"); },
  });
  await runSecurePlannedTests({ worktreePath: "/fixture" }, {
    scan, runTests, changes: () => assert.fail("no base means no changed set"),
  });
  assert.deepEqual(seen, [["a.cpp"], undefined, undefined]);
});

test("the review path scopes with reviewedPaths, so a praesidium.json-only PR analyzes the unit it reconfigures", async (t) => {
  const { root, base } = reconfiguredRepository(t, "int f() { return 0; }\n", { file: "a.cpp", standard: "c++20", defines: ["X=1"] });
  let seen;
  await runSecurePlannedTests({ worktreePath: root, mergeBase: base }, {
    scan: async (input) => { seen = input.changedPaths; return { status: "passed" }; },
    runTests: async () => [],
  });
  assert.deepEqual([...seen].sort(), ["a.cpp", "praesidium.json"]);
});

test("the CLI's --base scope brings a unit whose entry the PR drops into that PR", async (t) => {
  // Dropping the entry needs no compiler: the unit is in scope and no longer configured.
  const dropped = reconfiguredRepository(t, "int f() { return 0; }\n", null);
  const removal = runCli(dropped.root, dropped.base);
  assert.equal(removal.exitCode, 2);
  assert.deepEqual(removal.report.checks, [{ rule: "native.configuration-required", status: "error" }]);
  // Objective-C/C++ is opt-in: a dropped entry is reported as not analyzed instead.
  const platform = reconfiguredRepository(t, "int f() { return 0; }\n", null, "capture.mm");
  const opted = runCli(platform.root, platform.base);
  assert.equal(opted.exitCode, 0);
  assert.equal(opted.report.coverage.nativeScope, "changed");
  assert.deepEqual(opted.report.coverage.nativeNotAnalyzed, ["capture.mm"]);
});

test("real clang: the CLI's --base scope compiles a unit whose PR only changes its defines", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const source = "int read_value(int s) {\n#ifdef FEATURE\n  int *p = nullptr;\n  if (s > 0) return *p;\n#endif\n  return s;\n}\n";
  const { root, base } = reconfiguredRepository(t, source, { file: "a.cpp", standard: "c++20", defines: ["FEATURE=1"] });
  const { exitCode, report } = runCli(root, base);
  assert.equal(exitCode, 1);
  assert.equal(report.coverage.nativeScope, "changed");
  assert.equal(report.coverage.nativeUnits, 1);
  assert.ok(report.checks.some(check => check.file === "a.cpp" && check.status === "failed"));
});

test("unanalyzed Objective-C/C++ is an advisory on the board, not a silent pass", async () => {
  const [result] = await runSecurePlannedTests({ worktreePath: "/fixture" }, {
    scan: async () => ({ status: "passed", coverage: { nativeNotAnalyzed: ["app/capture.mm", "app/url.mm"] } }),
    runTests: async () => [],
  });
  assert.equal(result.status, "passed");
  assert.match(result.advisory, /Objective-C\/C\+\+ の 2 ファイルは静的解析されていません/);
  const [plain] = await runSecurePlannedTests({ worktreePath: "/fixture" }, {
    scan: async () => ({ status: "passed", coverage: { nativeNotAnalyzed: [] } }), runTests: async () => [],
  });
  assert.equal(plain.advisory, undefined);
});
