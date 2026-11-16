import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzerReports, hostAnalyzerReports, hostDirectories } from "../src/praesidium/native-host-reports.mjs";
import { lineDirectiveFiles } from "../src/praesidium/native-line-directives.mjs";
import { analyzeNative, analyzeProcess } from "../src/praesidium/native.mjs";
import { scanRepository } from "../src/praesidium/scan.mjs";
import { runSecurePlannedTests } from "../src/praesidium-ci.mjs";

function directory(t, git = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "praesidium-host-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (git) execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

// A repository with one unit and a host package holding the Tirocinium shape: Boost.Asio's
// awaitable.hpp, where the analyzer ends a coroutine path.
function layout(t, unitSource = "#include <boost/asio/awaitable.hpp>\nint main() { return 0; }\n") {
  const root = directory(t, true), sdk = directory(t);
  mkdirSync(join(sdk, "boost", "asio"), { recursive: true });
  writeFileSync(join(sdk, "boost", "asio", "awaitable.hpp"), "// host\n");
  writeFileSync(join(root, "http_client.cpp"), unitSource);
  return { root, sdk, header: join(sdk, "boost", "asio", "awaitable.hpp") };
}

const warning = (path, line, checker = "core.NullDereference") =>
  `${path}:${line}:5: warning: Dereference of null pointer [${checker}]`;
const note = (path, line) => `${path}:${line}:3: note: Calling 'f'`;

test("analyzer text output is read as warnings with their path notes, Windows drives included", () => {
  const text = [
    "In file included from http_client.cpp:1:",
    warning("C:\\host\\boost\\asio\\awaitable.hpp", 70),
    "   70 |     return *p;",
    note("http_client.cpp", 4), note("C:\\host\\boost\\asio\\awaitable.hpp", 69),
    "1 warning generated.",
  ].join("\n");
  const { reports, errors } = analyzerReports(text);
  assert.equal(errors, false);
  assert.deepEqual(reports, [{ path: "C:\\host\\boost\\asio\\awaitable.hpp", line: 70, checker: "core.NullDereference",
    notes: [{ path: "http_client.cpp", line: 4 }, { path: "C:\\host\\boost\\asio\\awaitable.hpp", line: 69 }] }]);
  assert.equal(analyzerReports("x.cpp:1:1: error: expected ';'").errors, true);
  assert.equal(analyzerReports("clang++: error: unknown argument").errors, true);
  assert.deepEqual(hostDirectories(["-I", "/a", "-isystem", "/b", "-isystem", "/c", "--", "x.cpp"]), ["/b", "/c"]);
});

test("a report that ends in a host package and runs mostly there is advisory; the rest block", (t) => {
  const { root, sdk, header } = layout(t);
  const classify = lines => hostAnalyzerReports(lines.join("\n"), root, [sdk]);
  // Tirocinium #3803: core.NullDereference inside boost/asio/awaitable.hpp.
  assert.deepEqual(classify([warning(header, 70), note("http_client.cpp", 2), note(header, 60), note(header, 70)]),
    { advisories: [{ file: "boost/asio/awaitable.hpp", line: 70, checker: "core.NullDereference" }], blocking: 0 });
  // A report without path notes that ends in the host is advisory too.
  assert.equal(classify([warning(header, 70)]).advisories.length, 1);
  // The caller side (core.NonNullParamChecker at the call in repository code) still fails.
  assert.deepEqual(classify([warning("http_client.cpp", 2, "core.NonNullParamChecker"), note(header, 60)]),
    { advisories: [], blocking: 1 });
  // A null passed down from repository code to a library dereference: mostly repository path.
  assert.deepEqual(classify([warning(header, 70), note("http_client.cpp", 1), note("http_client.cpp", 2), note(header, 70)]),
    { advisories: [], blocking: 1 });
  // A `..` that climbs out of the host directory back into the repository is not host code.
  const climbed = join(sdk, "..", root.split(/[\\/]/).at(-1), "http_client.cpp");
  assert.deepEqual(classify([warning(climbed, 2)]), { advisories: [], blocking: 1 });
  // One blocking report among advisories keeps the count; analyzeProcess then fails the pass.
  assert.deepEqual(classify([warning(header, 70), warning("http_client.cpp", 2)]).blocking, 1);
  // Unreadable output (an error) or no warning at all: not classified.
  assert.equal(classify(["http_client.cpp:1:1: error: boom"]), null);
  assert.equal(classify(["1 warning generated."]), null);
});

test("a host directory inside the repository is repository code", (t) => {
  const root = directory(t, true);
  mkdirSync(join(root, "vendor"));
  writeFileSync(join(root, "vendor", "lib.hpp"), "");
  assert.deepEqual(hostAnalyzerReports(warning(join(root, "vendor", "lib.hpp"), 3), root, [join(root, "vendor")]),
    { advisories: [], blocking: 1 });
});

test("analyzeProcess passes an analyzer pass whose reports all stay in host packages", async (t) => {
  const { root, sdk, header } = layout(t);
  const script = join(directory(t), "fake-analyzer.mjs");
  writeFileSync(script, "process.stderr.write(process.env.FAKE_OUTPUT);\n");
  const run = async (output) => {
    process.env.FAKE_OUTPUT = output;
    try { return await analyzeProcess(process.execPath, [script, "--analyze", "-isystem", sdk, "--", "http_client.cpp"], root); }
    finally { delete process.env.FAKE_OUTPUT; }
  };
  const host = await run(`${warning(header, 70)}\n${note(header, 69)}\n1 warning generated.\n`);
  assert.equal(host.ok, true);
  assert.equal(host.diagnostics, false);
  assert.deepEqual(host.hostReports, [{ file: "boost/asio/awaitable.hpp", line: 70, checker: "core.NullDereference" }]);
  assert.equal(host.output, undefined);
  const own = await run(`${warning("http_client.cpp", 2)}\n1 warning generated.\n`);
  assert.equal(own.diagnostics, true);
  assert.equal(own.hostReports, undefined);
  assert.equal(own.reason, "compiler-diagnostics");
});

test("#line in any spelling marks a repository file as able to relocate a report", (t) => {
  const root = directory(t, true);
  const spellings = { "a.cpp": '#line 70 "/opt/boost/asio/awaitable.hpp"\n', "b.cpp": '  %:  line 3 "x.hpp"\n',
    "c.cpp": '#/* c */line 3 "x.hpp"\n', "d.c": 'char *s = "R\\"(";\n#line 3 "x.hpp"\n' };
  for (const [file, source] of Object.entries(spellings)) writeFileSync(join(root, file), source);
  writeFileSync(join(root, "clean.cpp"), '// #line 3 "x"\nconst char* s = "#line 3";\n/*\n#line 3 */\n');
  // Read as C as well as C++, a raw string's `#line` line counts (fail closed).
  writeFileSync(join(root, "raw.cpp"), 'auto r = R"(\n#line 3\n)";\n');
  assert.deepEqual(lineDirectiveFiles(root, [...Object.keys(spellings), "clean.cpp", "raw.cpp"]), [...Object.keys(spellings), "raw.cpp"]);
  assert.deepEqual(lineDirectiveFiles(root, ["missing.cpp"]), ["missing.cpp"]);
});

// analyzeNative with a compiler double: the diagnostics pass lists what it read, the
// analyzer pass returns what analyzeProcess returns for host-only reports.
async function analyze(root, sdk, extra = []) {
  const unit = { file: "http_client.cpp", standard: "c++20", packages: ["odeum-boost-1-87-0"] };
  const host = { includePackages: { "odeum-boost-1-87-0": sdk } };
  const hostReports = [{ file: "boost/asio/awaitable.hpp", line: 70, checker: "core.NullDereference" }];
  return analyzeNative(root, [{ file: unit.file }, ...extra.map(file => ({ file }))], [unit], async (_command, args) =>
    args.includes("-MF") ? { ok: true, exitCode: 0, dependencies: [unit.file, ...extra, join(sdk, "boost", "asio", "awaitable.hpp")] }
      : args.includes("--analyze") ? { ok: true, exitCode: 0, diagnostics: false, hostReports } : { ok: true, exitCode: 0 },
  { host });
}

test("analyzeNative records host reports on a passing unit, and fails it when a read file holds #line", async (t) => {
  const { root, sdk } = layout(t);
  const [passed] = await analyze(root, sdk);
  assert.equal(passed.status, "passed");
  assert.equal(passed.hostReports.length, 1);
  writeFileSync(join(root, "relocate.hpp"), '#line 70 "awaitable.hpp"\n');
  const [relocated] = await analyze(root, sdk, ["relocate.hpp"]);
  assert.equal(relocated.status, "failed");
  assert.equal(relocated.reason, "host-report-relocatable");
});

test("scan coverage counts host reports and the preflight shows them as an advisory, not a failure", async (t) => {
  const { root, sdk } = layout(t);
  writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1,
    native: [{ file: "http_client.cpp", standard: "c++20", packages: ["odeum-boost-1-87-0"] }], web: [] }));
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  const hostReports = [{ file: "boost/asio/awaitable.hpp", line: 70, checker: "core.NullDereference" }];
  const report = await scanRepository({ root, nativeHost: { includePackages: { "odeum-boost-1-87-0": sdk } },
    nativeExecute: async (_command, args) => args.includes("-MF") ? { ok: true, exitCode: 0, dependencies: ["http_client.cpp"] }
      : args.includes("--analyze") ? { ok: true, exitCode: 0, hostReports } : { ok: true, exitCode: 0 } });
  assert.equal(report.status, "passed");
  assert.equal(report.coverage.nativeHostReports, 1);
  assert.deepEqual(report.checks[0].hostReports, hostReports);
  const [result] = await runSecurePlannedTests({ worktreePath: "/fixture" }, {
    scan: async () => ({ status: "passed", coverage: { nativeNotAnalyzed: ["a.mm"], nativeHostReports: 2 } }), runTests: async () => [],
  });
  assert.equal(result.status, "passed");
  assert.match(result.advisory, /Objective-C\/C\+\+ の 1 ファイル/);
  assert.match(result.advisory, /host package ヘッダ内で完結した analyzer report 2 件を記録のみ/);
});
