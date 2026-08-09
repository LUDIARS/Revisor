import assert from "node:assert/strict";
import test from "node:test";
import { runAnatomiaReviewGate } from "../src/anatomia-review-gate.mjs";

const classification = {
  docsOnly: false,
  docsOrConfigOnly: false,
  codeDomainRequired: true,
};
const plan = { stages: [{ id: "anatomia_code_analysis", run: true }] };

function passingAnalysis() {
  return {
    domain: { hasTargetDomain: true, targetDomains: [], unassignedAnchors: [] },
    quality: { changedFunctions: [], changedOrphans: [], complexity: { score: 100, functions: 0 } },
    architecture: { verify: { pass: true, gates: [] }, changedViolations: [] },
  };
}

function gate(options) {
  return runAnatomiaReviewGate({
    enabled: true,
    resolveCli: async () => "anatomia-cli",
    analyze: async () => passingAnalysis(),
    anatomiaFolder: "anatomia-root",
    cwd: "head-worktree",
    base: "merge-base",
    plan,
    classification,
    ...options,
  });
}

test("blocks LLM review before it starts when Anatomia finds a violation", async () => {
  const result = await gate({
    analyze: async () => ({
      ...passingAnalysis(),
      architecture: {
        verify: { pass: true, gates: [] },
        changedViolations: [{ severity: "error", message: "forbidden dependency" }],
      },
    }),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reasons[0], /architecture rule violation/);
  assert.match(result.reasons.at(-1), /forbidden dependency/);
});

test("passes to LLM review when Anatomia finds no violation", async () => {
  const result = await gate();
  assert.equal(result.status, "passed");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.cliPath, "anatomia-cli");
});

test("honors a review plan that skips the target-domain gate", async () => {
  const result = await gate({
    plan: { stages: [{ id: "anatomia_domain_review", run: false }] },
    analyze: async () => ({
      ...passingAnalysis(),
      domain: {
        hasTargetDomain: false,
        targetDomains: [],
        unassignedAnchors: ["fn:changed"],
      },
      quality: {
        ...passingAnalysis().quality,
        changedFunctions: [{ anchor: "fn:changed" }],
      },
    }),
  });
  assert.equal(result.status, "passed");
});

test("records an unavailable Anatomia gate and permits LLM review", async () => {
  const result = await gate({
    analyze: async () => {
      throw new Error("RAW_DIAGNOSTIC_SHOULD_NOT_PERSIST");
    },
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /passed through/);
  assert.match(result.reason, /PR analysis failed/);
  assert.doesNotMatch(JSON.stringify(result), /RAW_DIAGNOSTIC_SHOULD_NOT_PERSIST/);
  assert.deepEqual(result.analysis.availability, {
    status: "unavailable",
    reason: "Anatomia PR analysis failed",
  });
  assert.equal(result.analysis.architecture.verify.pass, true);
});
