import test from "node:test";
import assert from "node:assert/strict";
import { isWrittenLine, parseWrittenLines, WHOLE_FILE } from "../src/cpp-code-checks/changed-lines.mjs";
import { CODE_CHECK_UNIMPLEMENTED_REASON, CPP_CODE_CHECK_NAME, runCppCodeChecks } from "../src/cpp-code-checks/run.mjs";
import { runCppCheckedTests } from "../src/cpp-code-check-ci.mjs";
import { testsPassed } from "../src/ci.mjs";

const DIFF = [
  "diff --git a/src/a.cpp b/src/a.cpp",
  "--- a/src/a.cpp",
  "+++ b/src/a.cpp",
  "@@ -3,0 +4,2 @@ void f() {",
  "+  int* p = new int(1);",
  "+  delete p;",
  "@@ -10 +12 @@",
  "-old();",
  "+fresh();",
  "@@ -20,2 +23,0 @@",
  "-gone();",
  "-gone();",
].join("\n");

test("parseWrittenLines keeps added ranges and drops pure deletions", () => {
  const written = parseWrittenLines(DIFF);
  assert.deepEqual(written.get("src/a.cpp"), [[4, 5], [12, 12]]);
  assert.equal(isWrittenLine(written, "src/a.cpp", 5), true);
  assert.equal(isWrittenLine(written, "src/a.cpp", 6), false);
  assert.equal(isWrittenLine(written, "src/a.cpp", 23), false);
  assert.equal(isWrittenLine(new Map([["n.cpp", WHOLE_FILE]]), "n.cpp", 9999), true);
});

function report(findings) {
  return JSON.stringify({ version: 1, files: 2, findings, totals: {}, parseErrors: [] });
}

function fakeRun({ diff = DIFF, codeCheck = { exitCode: 0, stdout: report([]) }, calls = [] } = {}) {
  return async (request) => {
    calls.push(request);
    if (request.command === "git") return { ok: true, exitCode: 0, stdout: diff, stderr: "" };
    return { ok: codeCheck.exitCode === 0, stderr: "", ...codeCheck };
  };
}

const base = { worktreePath: "/wt", mergeBase: "abc123", anatomiaFolder: "/anatomia" };
const deps = (overrides = {}) => ({
  changes: () => ["src/a.cpp", "src/new.hpp", "docs/readme.md", "tool.c"],
  resolveCli: async (folder) => { assert.equal(folder, "/anatomia"); return "/anatomia/bin/anatomia.mjs"; },
  now: () => 0,
  ...overrides,
});

test("only C++ sources are checked, as one stdin list, with Anatomia owning the rules", async () => {
  const calls = [];
  const result = await runCppCodeChecks(base, deps({ run: fakeRun({ calls }) }));
  assert.equal(result.status, "passed");
  const check = calls.find((call) => call.command !== "git");
  assert.deepEqual(check.args, [
    "/anatomia/bin/anatomia.mjs", "code-check", "--repo", "/wt", "--files-from", "-", "--json", "--fail-on", "none",
  ]);
  assert.equal(check.stdin, "src/a.cpp\nsrc/new.hpp\n");
  const diff = calls.find((call) => call.command === "git");
  assert.deepEqual(diff.args.slice(-3), ["--", "src/a.cpp", "src/new.hpp"]);
});

test("error findings on written lines fail; findings elsewhere and lower severities do not", async () => {
  const findings = [
    { file: "src/a.cpp", line: 4, rule: "memory/raw-new", severity: "error", message: "raw new" },
    { file: "src/a.cpp", line: 30, rule: "memory/raw-delete", severity: "error", message: "legacy delete" },
    { file: "src/a.cpp", line: 12, rule: "obfuscation/goto", severity: "warning", message: "goto" },
    { file: "src/new.hpp", line: 7, rule: "comment/missing-doc", severity: "warning", message: "doc" },
  ];
  const result = await runCppCodeChecks(base, deps({ run: fakeRun({ codeCheck: { exitCode: 0, stdout: report(findings) } }) }));
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.codeChecks.writtenFindings, { error: 1, warning: 2, info: 0 });
  assert.equal(result.codeChecks.outsideWrittenLines, 1);
  assert.match(result.output.text, /^src\/a\.cpp:4: error: raw new \[memory\/raw-new\]/);
  assert.doesNotMatch(result.output.text, /legacy delete/);

  const advisoryOnly = await runCppCodeChecks(base, deps({ run: fakeRun({ codeCheck: { exitCode: 0, stdout: report(findings.slice(1)) } }) }));
  assert.equal(advisoryOnly.status, "passed");
  assert.match(advisoryOnly.output.text, /missing-doc/);
});

test("no changed C++ source means the check does not apply", async () => {
  const result = await runCppCodeChecks(base, deps({ changes: () => ["README.md", "main.c"], run: fakeRun() }));
  assert.equal(result, null);
});

test("fails closed when Anatomia, git or the report cannot be trusted", async () => {
  const unresolved = await runCppCodeChecks(base, deps({ resolveCli: async () => { throw new Error("C:/secret/path"); }, run: fakeRun() }));
  assert.equal(unresolved.status, "error");
  assert.doesNotMatch(unresolved.reason, /secret/);

  const listing = await runCppCodeChecks(base, deps({ changes: () => { throw new Error("git"); }, run: fakeRun() }));
  assert.equal(listing.status, "error");

  for (const codeCheck of [
    { exitCode: 2, stdout: "" },
    { exitCode: 0, stdout: "not json" },
    { exitCode: 0, stdout: JSON.stringify({ version: 2, findings: [] }) },
    { exitCode: 0, stdout: JSON.stringify({ version: 1, findings: [{ file: "a.cpp", line: 1, rule: "x", severity: "fatal" }] }) },
  ]) {
    const result = await runCppCodeChecks(base, deps({ run: fakeRun({ codeCheck }) }));
    assert.equal(result.status, "error", JSON.stringify(codeCheck));
    assert.equal(result.exitCode, 2);
  }
});

test("an Anatomia without code-check skips the row; one with it still fails closed", async () => {
  const unknown = {
    exitCode: 1,
    stdout: "",
    stderr: 'anatomia: Unknown subcommand "code-check". Expected: verify | context | where | find',
  };
  const skipped = await runCppCodeChecks(base, deps({ run: fakeRun({ codeCheck: unknown }) }));
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, CODE_CHECK_UNIMPLEMENTED_REASON);
  assert.equal(skipped.advisory, CODE_CHECK_UNIMPLEMENTED_REASON);
  assert.equal(testsPassed([skipped]), true);

  for (const codeCheck of [
    { exitCode: 1, stdout: "", stderr: 'Unknown subcommand "code-checks"' },
    { exitCode: 1, stdout: "", stderr: "anatomia: crashed" },
    { exitCode: 0, stdout: 'Unknown subcommand "code-check"', stderr: "" },
    { exitCode: 0, stdout: JSON.stringify({ version: 2, findings: [] }), stderr: "" },
  ]) {
    const result = await runCppCodeChecks(base, deps({ run: fakeRun({ codeCheck }) }));
    assert.equal(result.status, "error", JSON.stringify(codeCheck));
    assert.equal(testsPassed([result]), false);
  }
});

test("an unknown merge base errors only when the repository has C++", async () => {
  const withCpp = async (request) => ({ ok: true, exitCode: 0, stdout: "src/a.cpp\0README.md\0", stderr: "" });
  const withoutCpp = async () => ({ ok: true, exitCode: 0, stdout: "README.md\0tool.c\0", stderr: "" });
  const missing = { worktreePath: "/wt", anatomiaFolder: "/anatomia" };
  assert.equal((await runCppCodeChecks(missing, deps({ run: withCpp }))).status, "error");
  assert.equal(await runCppCodeChecks(missing, deps({ run: withoutCpp })), null);
});

test("the C++ row precedes the registered tests and does not stop them", async () => {
  const events = [];
  const options = { onCheckResult: async (check) => events.push(`result:${check.name}`) };
  const outcomes = await runCppCheckedTests(options, {
    check: async () => ({ name: CPP_CODE_CHECK_NAME, status: "failed" }),
    runTests: async () => { events.push("tests"); return [{ name: "unit", status: "passed" }]; },
  });
  assert.deepEqual(events, [`result:${CPP_CODE_CHECK_NAME}`, "tests"]);
  assert.deepEqual(outcomes.map((o) => o.name), [CPP_CODE_CHECK_NAME, "unit"]);

  const none = await runCppCheckedTests({}, { check: async () => null, runTests: async () => [{ name: "unit", status: "passed" }] });
  assert.deepEqual(none.map((o) => o.name), ["unit"]);
});
