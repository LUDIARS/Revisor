import test from "node:test";
import assert from "node:assert/strict";
import { nativeProcessResult } from "../src/praesidium/native-process-result.mjs";
import { analyzeNativeBatch } from "../src/praesidium/native-batch.mjs";
import { analyzeProcess } from "../src/praesidium/native.mjs";

test("warning-only compiler output remains a failure with its actionable location", async () => {
  const result = nativeProcessResult(null, "", "vendor/boost/a.ipp:319:21: warning: unused value [deadcode.DeadStores]");
  const [check] = await analyzeNativeBatch([{file: "unit.cpp",command:"unused",passes:[[]],cwd:"."}], async () => result);
  assert.equal(check.status, "failed");
  assert.equal(check.reason, "compiler-diagnostics");
  assert.match(check.output.text, /a\.ipp:319:21/);
});

test("termination, missing compiler and output limits are distinct and never pass", () => {
  for (const [error, reason] of [[{killed:true,signal:"SIGTERM"},"terminated"],
    [{code:"ENOENT"},"compiler-unavailable"],
    [{code:"ERR_CHILD_PROCESS_STDIO_MAXBUFFER",killed:true},"output-limit"]]) {
    const result = nativeProcessResult(error);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.reason, reason);
  }
});

test("clean analysis retains no output and diagnostic output stays bounded", () => {
  assert.deepEqual(nativeProcessResult(null, "ordinary compiler output"), {ok:true,exitCode:0,diagnostics:false});
  const result = nativeProcessResult({code:1}, "", "detail\n".repeat(5000)+"error: final failure");
  assert.equal(result.output.truncated,true);
  assert.ok(Buffer.byteLength(result.output.text)<13000);
  assert.match(result.output.text,/final failure/);
});

test("preprocessing failure never stores the expanded source printed on stdout", async () => {
  const result = await analyzeProcess(process.execPath, ["-e",
    "process.stdout.write('private expanded source');process.stderr.write('error: compile failed');process.exitCode=1", "--", "-E"], process.cwd());
  assert.equal(result.ok,false);
  assert.match(result.output.text,/compile failed/);
  assert.doesNotMatch(result.output.text,/private expanded source/);
});
