import assert from "node:assert/strict";
import test from "node:test";
import { gateOutcome } from "../src/review-gate.mjs";

function analysis({ gates = [], changedOrphans = [], changedViolations = [] } = {}) {
  return {
    domain: { hasTargetDomain: true },
    quality: { changedOrphans, complexity: { score: 70 } },
    architecture: {
      verify: gates.length === 0
        ? { pass: true, gates: [] }
        : { pass: gates.every((gate) => gate.pass), gates },
      changedViolations,
    },
  };
}

const PASSING_CI = [{ name: "unit", status: "passed" }];
const CLEAN_LEAKAGE = { totalFindings: 0 };

function evaluate(finalAnalysis, overrides = {}) {
  return gateOutcome({
    finalAnalysis,
    complexityScoreDelta: 0,
    threshold: 10,
    reviewerOutput: "",
    leakage: CLEAN_LEAKAGE,
    ci: PASSING_CI,
    ...overrides,
  });
}

test("reports spec linkage and orphans without blocking the merge", () => {
  const outcome = evaluate(analysis({
    gates: [
      { gate: "rule_conformance", pass: true },
      { gate: "duplication", pass: true },
      { gate: "spec_linkage", pass: false },
    ],
    changedOrphans: [{ name: "handle" }, { name: "render" }],
  }));
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "2 changed function(s) are orphaned",
    "Anatomia gate(s) did not pass: spec_linkage",
  ]);
});

test("still blocks on gates other than spec linkage", () => {
  const outcome = evaluate(analysis({
    gates: [
      { gate: "rule_conformance", pass: false },
      { gate: "spec_linkage", pass: false },
    ],
  }));
  assert.deepEqual(outcome.reasons, ["Anatomia gate(s) did not pass: rule_conformance"]);
  assert.deepEqual(outcome.advisories, ["Anatomia gate(s) did not pass: spec_linkage"]);
});

test("never turns an unexplained verification failure into a pass", () => {
  const finalAnalysis = analysis();
  finalAnalysis.architecture.verify = { pass: false, gates: [] };
  const outcome = evaluate(finalAnalysis);
  assert.deepEqual(outcome.reasons, ["Anatomia gate(s) did not pass: unspecified"]);
});

test("blocks on failed tests, leakage, error violations and complexity drops", () => {
  const outcome = evaluate(
    analysis({
      changedViolations: [
        { severity: "error" },
        { severity: "warning" },
      ],
    }),
    {
      ci: [{ name: "unit", status: "failed" }],
      leakage: { totalFindings: 1 },
      complexityScoreDelta: -12,
    },
  );
  assert.deepEqual(outcome.reasons, [
    "1 registered test case(s) failed",
    "1 changed architecture rule violation(s) remain",
    "complexity score dropped by 12 points",
    "1 potential information leakage finding(s) remain",
  ]);
  assert.deepEqual(outcome.advisories, [
    "1 non-blocking architecture rule violation(s) remain",
  ]);
});

test("passes a clean analysis with no advisories", () => {
  const outcome = evaluate(analysis());
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, []);
});
