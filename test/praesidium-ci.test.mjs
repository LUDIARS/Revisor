import test from "node:test";
import assert from "node:assert/strict";
import { runSecurePlannedTests } from "../src/praesidium-ci.mjs";
import { testsPassed } from "../src/ci.mjs";

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
  assert.equal(testsPassed(outcomes), true);
});

test("findings, unavailable scan and unknown results block before setup/install", async () => {
  for (const scan of [async () => ({ status: "failed" }), async () => ({ status: "error" }),
    async () => ({ status: "skipped" }), async () => null, async () => { throw new Error("unavailable"); }]) {
    const outcomes = await runSecurePlannedTests({ worktreePath: "/fixture" }, {
      scan, runTests: async () => { assert.fail("must not run setup or tests"); },
    });
    assert.equal(testsPassed(outcomes), false);
    assert.equal(outcomes.length, 1);
  }
});
