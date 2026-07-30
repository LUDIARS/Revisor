import assert from "node:assert/strict";
import test from "node:test";
import { gateOutcome, isDocsOnlyChange, needsTargetDomain } from "../src/review-gate.mjs";

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

test("blocks a code change whose target domain is missing", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  const outcome = evaluate(finalAnalysis);
  assert.deepEqual(outcome.reasons, ["target domain is still missing"]);
  assert.deepEqual(outcome.advisories, []);
});

test("relaxes a missing target domain to an advisory for a docs-only change", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  const outcome = evaluate(finalAnalysis, { docsOnly: true });
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "target domain is still missing (docs-only change)",
  ]);
});

test("docs-only relaxation never bypasses the other gates", () => {
  const finalAnalysis = analysis({ gates: [{ gate: "rule_conformance", pass: false }] });
  finalAnalysis.domain.hasTargetDomain = false;
  const outcome = evaluate(finalAnalysis, {
    docsOnly: true,
    ci: [{ name: "unit", status: "failed" }],
    reviewerOutput: "PR_GATE_NEEDS_HUMAN",
  });
  assert.deepEqual(outcome.reasons, [
    "1 registered test case(s) failed",
    "Anatomia gate(s) did not pass: rule_conformance",
    "reviewer reported insufficient information for a safe domain/spec definition",
  ]);
});

test("isDocsOnlyChange accepts documentation extensions only", () => {
  assert.equal(isDocsOnlyChange(["spec/plan/multi-site.md", "README.md"]), true);
  assert.equal(isDocsOnlyChange(["docs/guide.adoc", "notes.TXT"]), true);
  assert.equal(isDocsOnlyChange(["spec/plan/multi-site.md", "src/runner.mjs"]), false);
  assert.equal(isDocsOnlyChange(["src/index.ts"]), false);
  assert.equal(isDocsOnlyChange([]), false);
});

test("isDocsOnlyChange reads an unquoted non-ASCII documentation path", () => {
  assert.equal(isDocsOnlyChange(["spec/計画.md"]), true);
});

test("needsTargetDomain follows the docs-only relaxation", () => {
  const withDomain = analysis();
  const withoutDomain = structuredClone(withDomain);
  withoutDomain.domain.hasTargetDomain = false;
  assert.equal(needsTargetDomain(withoutDomain), true);
  assert.equal(needsTargetDomain(withoutDomain, true), false);
  assert.equal(needsTargetDomain(withDomain), false);
  assert.equal(needsTargetDomain(withDomain, true), false);
});
