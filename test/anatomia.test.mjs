import assert from "node:assert/strict";
import test from "node:test";
import { analyzePr } from "../src/anatomia.mjs";

function capture(stdout = "{}", ok = true) {
  const calls = [];
  return {
    calls,
    run: async (options) => {
      calls.push(options);
      return { ok, stdout, stderr: "" };
    },
  };
}

test("analyzePr runs pr-review without the dual-layer enforcement flag by default", async () => {
  const runner = capture('{"domain":{}}');
  const analysis = await analyzePr({ cliPath: "anatomia.mjs", cwd: "head", base: "base", run: runner.run });
  assert.deepEqual(analysis, { domain: {} });
  assert.deepEqual(runner.calls[0].args, [
    "anatomia.mjs", "pr-review", "--repo", "head", "--base", "base", "--json",
  ]);
  assert.equal(runner.calls[0].env.ANATOMIA_CACHE, "off");
});

test("analyzePr forwards --enforce-dual-layer-domain-gate only when enforcement is requested", async () => {
  const runner = capture();
  await analyzePr({
    cliPath: "anatomia.mjs", cwd: "head", base: "base", enforceDualLayerDomainGate: true, run: runner.run,
  });
  assert.ok(runner.calls[0].args.includes("--enforce-dual-layer-domain-gate"));
  await analyzePr({
    cliPath: "anatomia.mjs", cwd: "head", base: "base", enforceDualLayerDomainGate: "yes", run: runner.run,
  });
  // Only a boolean true enforces: a truthy string from a stale setting must not.
  assert.equal(runner.calls[1].args.includes("--enforce-dual-layer-domain-gate"), false);
});

test("analyzePr preserves an enforced dual-layer verdict emitted with a non-zero exit", async () => {
  const analysis = {
    domain: { dualLayer: { mode: "enforced", wouldBlock: true, blocking: true } },
  };
  const runner = capture(JSON.stringify(analysis), false);
  assert.deepEqual(
    await analyzePr({
      cliPath: "anatomia.mjs", cwd: "head", base: "base", enforceDualLayerDomainGate: true, run: runner.run,
    }),
    analysis,
  );
});

test("analyzePr still rejects unrelated non-zero exits in enforced mode", async () => {
  const runner = capture('{"error":"analysis failed"}', false);
  await assert.rejects(
    analyzePr({
      cliPath: "anatomia.mjs", cwd: "head", base: "base", enforceDualLayerDomainGate: true, run: runner.run,
    }),
    /Anatomia PR analysis failed/,
  );
});
