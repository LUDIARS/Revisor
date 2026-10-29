import test from "node:test";
import assert from "node:assert/strict";
import { runSecurePlannedTests } from "../src/praesidium-ci.mjs";

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
