import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFindings } from "../src/praesidium/rules.mjs";
import { scanRepository } from "../src/praesidium/scan.mjs";
import { nativeInvocation, analyzeNative } from "../src/praesidium/native.mjs";
import { readNativeHost } from "../src/praesidium/native-host.mjs";
import { analyzeNativeBatch } from "../src/praesidium/native-batch.mjs";

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

test("JS evaluation keeps bare and global calls blocked without conflating Redis methods or TS declarations", () => {
  for (const code of ["eval(input)", "new Function(input)", "Function(input)",
    "globalThis.eval(input)", "window . eval(input)", "self.eval(input)",
    "global.eval(input)", "globalThis?.eval?.(input)", "eval?.(input)",
    "window.Function(input)", "eval({ script: input })", "eval(flag ? a : b)",
    "globalThis /* receiver */ . /* member */ eval(input)"]) {
    assert.equal(sourceFindings("source.ts", code)[0]?.rule, "web.dynamic-code", code);
  }
  for (const code of ["await redis.eval(SCRIPT, 1, key)",
    "await this.client.eval(SCRIPT, 2, first, second)",
    "interface RedisPort { eval(script: string, numKeys: number): Promise<unknown>; }",
    "class Fake { async eval(script: string, numKeys: number) { return 1; } }"]) {
    assert.deepEqual(sourceFindings("source.ts", code), [], code);
  }
  assert.equal(sourceFindings("source.ts", "redis.eval(SCRIPT);\neval(input)")[0].line, 2);
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

test("host-owned packages resolve without running repository setup or accepting external PR paths", (t) => {
  const root = fixture(t), hostRoot = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const compiler = join(hostRoot, "compiler");
  writeFileSync(compiler, "fixture only; never executed");
  const configPath = join(hostRoot, "praesidium.host.json");
  const env = { REVISOR_CONFIG_PATH: join(hostRoot, "revisor.config.json") };
  const config = { version: 1, compilers: { cpp: compiler }, includePackages: { tela: hostRoot } };
  writeFileSync(configPath, JSON.stringify(config));
  const host = readNativeHost(root, env);
  const unit = { file: "unit.cpp", standard: "c++20", packages: ["tela"] };
  const invocation = nativeInvocation(root, unit, host);
  assert.equal(invocation.command, compiler);
  assert.ok(invocation.args.includes(hostRoot));
  assert.throws(() => nativeInvocation(root, { ...unit, includes: [hostRoot] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["missing"] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["../tela"] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["tela", "tela"] }, host));
  writeFileSync(configPath, JSON.stringify({ ...config, includePackages: { tela: "relative" } }));
  assert.throws(() => readNativeHost(root, env));
  writeFileSync(join(root, "praesidium.host.json"), JSON.stringify(config));
  assert.throws(() => readNativeHost(root, { REVISOR_CONFIG_PATH: join(root, "config.json") }));
});

test("missing host packages fail before any compiler is started", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const units = [{ file: "unit.cpp", standard: "c++20", packages: ["uninstalled"] }];
  let calls = 0;
  await assert.rejects(analyzeNative(root, [{ file: "unit.cpp" }], units,
    async () => { calls++; return { ok: true }; }, { host: {} }));
  assert.equal(calls, 0);
});

test("native batch keeps at most two compilers alive and reports all units in input order", async () => {
  let active = 0, peak = 0;
  const units = Array.from({ length: 7 }, (_, index) => ({ file: `${index}.cpp`, command: "fixture", args: [index], cwd: "." }));
  const outcomes = await analyzeNativeBatch(units, async (_command, [index]) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (index === 2) throw new Error("private compiler failure");
    return { ok: true, exitCode: 0, diagnostics: index === 4 };
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(outcomes.map(item => item.file), units.map(item => item.file));
  assert.deepEqual(outcomes.map(item => item.status), ["passed", "passed", "error", "passed", "failed", "passed", "passed"]);
  assert.ok(!JSON.stringify(outcomes).includes("private compiler failure"));
});

test("expired native scheduling budget explicitly reports every unstarted unit", async () => {
  let clock = 0, calls = 0;
  const units = ["a", "b", "c"].map(file => ({ file, command: "fixture", args: [], cwd: "." }));
  const outcomes = await analyzeNativeBatch(units, async () => {
    calls++; clock = 1_000_000;
    return { ok: true, exitCode: 0 };
  }, () => clock);
  assert.equal(calls, 1);
  assert.deepEqual(outcomes.map(item => item.status), ["passed", "error", "error"]);
  assert.equal(outcomes[1].rule, "native.analysis-budget");
  assert.equal(outcomes[2].rule, "native.analysis-budget");
});

test("large native batches inspect every unit beyond the old two-minute cutoff", async () => {
  let clock = 0, calls = 0;
  const units = Array.from({ length: 8 }, (_, index) => ({
    file: `unit-${index}.cpp`, command: "fixture", args: [], cwd: ".",
  }));
  const outcomes = await analyzeNativeBatch(units, async () => {
    calls++; clock += 25_000;
    return { ok: true, exitCode: 0 };
  }, () => clock);
  assert.equal(calls, units.length);
  assert.equal(outcomes.length, units.length);
  assert.ok(outcomes.every(check => check.status === "passed"));
});
