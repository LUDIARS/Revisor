import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFindings } from "../src/praesidium/rules.mjs";
import { scanRepository } from "../src/praesidium/scan.mjs";
import { nativeInvocation, analyzeNative } from "../src/praesidium/native.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "praesidium-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("syntactic rules identify concrete dangerous calls without reporting literals/comments", () => {
  assert.equal(sourceFindings("a.cpp", "void f() { strcpy(dst, src); }")[0].rule, "native.unbounded-copy");
  assert.equal(sourceFindings("a.js", "eval(userInput)")[0].rule, "web.dynamic-code");
  assert.equal(sourceFindings("a.js", "node.innerHTML = req.query.content")[0].rule, "web.request-to-html");
  assert.equal(sourceFindings("a.js", "exec(req.body.cmd)")[0].rule, "web.request-to-shell");
  assert.deepEqual(sourceFindings("a.js", '// eval(foo)\nconst x = "eval(foo)";'), []);
  assert.deepEqual(sourceFindings("a.cpp", '/* strcpy(a,b) */\nconst char* text = "strcpy(a,b)";'), []);
});

test("unconfigured native sources and failed collection never become passes", async (t) => {
  const root = fixture(t);
  const result = await scanRepository({ root, collect: () => [{ file: "a.cpp", source: "int main(){}" }] });
  assert.equal(result.status, "error");
  assert.equal(result.checks[0].rule, "native.configuration-required");
  const unreadable = await scanRepository({ root, collect: () => { throw new Error("SECRET"); } });
  assert.equal(unreadable.status, "error");
  assert.equal(JSON.stringify(unreadable).includes("SECRET"), false);
});

test("finding flood is bounded and remains a failing inspection", () => {
  const findings = sourceFindings("flood.js", "eval(input);\n".repeat(1000));
  assert.equal(findings.length, 201);
  assert.equal(findings.at(-1).rule, "inspection.finding-limit");
  assert.equal(findings[199].line, 200);
});

test("native analysis uses fixed compiler arguments, reports warning-only failures and missing compiler", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const unit = { file: "unit.cpp", standard: "c++20", defines: ["FEATURE=1"], includes: ["."] };
  const command = nativeInvocation(root, unit);
  assert.equal(command.command, "clang++");
  assert.ok(command.args.includes("--analyze"));
  assert.ok(command.args.includes("-Werror"));
  assert.throws(() => nativeInvocation(root, { ...unit, defines: ["X -Xclang -load evil"] }));
  assert.throws(() => nativeInvocation(root, { ...unit, includes: [".."] }));
  const sources = [{ file: "unit.cpp" }];
  assert.equal((await analyzeNative(root, sources, [unit], async () => ({ ok: true, exitCode: 0, diagnostics: true })))[0].status, "failed");
  assert.equal((await analyzeNative(root, sources, [unit], async () => ({ ok: false, exitCode: null })))[0].status, "error");
});

test("safe supported code reports limited coverage, not whole-program security", async (t) => {
  const root = fixture(t);
  const result = await scanRepository({ root, collect: () => [{ file: "a.js", source: "export const sum = (a,b) => a+b;" }] });
  assert.equal(result.status, "passed");
  assert.equal(result.coverage.webRuntimeWiring, "not-verified");
  assert.equal(result.coverage.webContracts, 0);
  writeFileSync(join(root, "praesidium.json"), '{"version":1,"unknown":true}');
  assert.equal((await scanRepository({ root, collect: () => [] })).status, "error");
});
