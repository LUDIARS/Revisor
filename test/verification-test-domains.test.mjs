import assert from "node:assert/strict";
import test from "node:test";
import { verificationTestDomains } from "../src/verification-test-domains.mjs";

const analysis = (targetDomains) => ({ domain: { targetDomains } });

test("uses the current analysis when partial verification already has one", () => {
  assert.deepEqual(verificationTestDomains(analysis(["billing"]), analysis(["old"])), ["billing"]);
});

test("falls back to the previous review's domains while Anatomia is still to be re-run", () => {
  assert.deepEqual(verificationTestDomains(null, analysis(["harness-reliability", "tooling"])), ["harness-reliability", "tooling"]);
});

test("fails with a clear reason instead of reading a null analysis", () => {
  assert.throws(() => verificationTestDomains(null, null), /previous Anatomia result/);
});
