import assert from "node:assert/strict";
import test from "node:test";
import { classifyChange } from "../src/change-classification.mjs";
import {
  RUNTIME_CHECK_MARKER,
  assessMergeRisk,
  assessRuntimeVerification,
  riskBandOf,
} from "../src/merge-risk.mjs";

const CLEAN_ANALYSIS = {
  domain: { hasTargetDomain: true, targetDomains: [{ name: "review-gate" }] },
  quality: { complexity: { score: 80 }, changedOrphans: [] },
  architecture: { changedViolations: [], verify: { pass: true, gates: [] } },
};

function profile(changedPaths, unifiedDiff = "") {
  return classifyChange({ changedPaths, unifiedDiff });
}

function pointsFor(assessment, code) {
  return assessment.factors.find((factor) => factor.code === code)?.points ?? 0;
}

test("a documentation change needs no runtime verification", () => {
  const runtime = assessRuntimeVerification({
    classification: profile(["README.md"]),
    testCases: [{ name: "docs-lint" }],
    ci: [{ name: "docs-lint", status: "passed" }],
  });
  assert.equal(runtime.required, false);
  assert.equal(runtime.score, 0);
});

test("a migration and an entrypoint change demand a human run", () => {
  const runtime = assessRuntimeVerification({
    classification: profile(["src/server.mjs", "migrations/031_x.sql"]),
    testCases: [{ name: "unit" }],
    ci: [{ name: "unit", status: "passed" }],
  });
  assert.equal(runtime.required, true);
  assert.equal(pointsFor(runtime, "surface:migration"), 35);
  assert.equal(pointsFor(runtime, "surface:entrypoint"), 30);
  assert.equal(pointsFor(runtime, "no_runtime_test_registered"), 20);
});

test("a passing runtime test buys the requirement down without clearing it", () => {
  const classification = profile(["src/server.mjs", "migrations/031_x.sql"]);
  const testCases = [{ name: "smoke", runtime: true }];
  const withoutEvidence = assessRuntimeVerification({
    classification,
    testCases,
    ci: [{ name: "smoke", status: "failed" }],
  });
  const withEvidence = assessRuntimeVerification({
    classification,
    testCases,
    ci: [{ name: "smoke", status: "passed" }],
  });
  assert.equal(withEvidence.score, withoutEvidence.score - 40);
  assert.deepEqual(withEvidence.evidence, ["smoke"]);
  assert.equal(withEvidence.required, true);
});

test("the reviewer marker alone can require a human run", () => {
  const runtime = assessRuntimeVerification({
    classification: profile(["src/review-gate.mjs"]),
    testCases: [{ name: "unit", runtime: true }],
    ci: [{ name: "unit", status: "passed" }],
    reviewerOutput: `looks fine but ${RUNTIME_CHECK_MARKER} because the gate cannot be exercised`,
  });
  assert.equal(pointsFor(runtime, "reviewer_marker"), 30);
});

test("a small clean documentation change scores as low risk", () => {
  const classification = profile(["README.md"], "+++ b/README.md\n+one line\n");
  const risk = assessMergeRisk({
    classification,
    analysis: CLEAN_ANALYSIS,
    complexityScoreDelta: 0,
    leakage: { totalFindings: 0 },
    ci: [{ name: "docs-lint", status: "passed" }],
    runtimeVerification: { required: false, score: 0 },
    docsOnly: true,
  });
  assert.equal(risk.score, 0);
  assert.equal(risk.band, "low");
});

test("outstanding leakage or a blocking reason saturates the score", () => {
  const classification = profile(["src/a.mjs"], "+++ b/src/a.mjs\n+x\n");
  const leaked = assessMergeRisk({
    classification,
    analysis: CLEAN_ANALYSIS,
    leakage: { totalFindings: 1 },
    ci: [],
    runtimeVerification: { required: false, score: 0 },
  });
  assert.equal(leaked.score, 100);
  assert.equal(leaked.band, "critical");
  const blocked = assessMergeRisk({
    classification,
    reasons: ["target domain is still missing"],
    analysis: CLEAN_ANALYSIS,
    leakage: { totalFindings: 0 },
    ci: [],
    runtimeVerification: { required: false, score: 0 },
  });
  assert.equal(blocked.score, 100);
});

test("does not price a missing function domain when there are no analyzable anchors", () => {
  const analysis = structuredClone(CLEAN_ANALYSIS);
  analysis.domain = {
    hasTargetDomain: false,
    targetDomains: [],
    unassignedAnchors: [],
  };
  analysis.quality.changedFunctions = [];
  const risk = assessMergeRisk({
    classification: profile(["start-service.bat"]),
    analysis,
    leakage: { totalFindings: 0 },
    ci: [],
    runtimeVerification: { required: false, score: 0 },
  });
  assert.equal(pointsFor(risk, "missing_domain"), 0);
  assert.ok(pointsFor(risk, "change_surface") > 0);
});

test("does not price an application domain for parseable non-code helpers", () => {
  const analysis = structuredClone(CLEAN_ANALYSIS);
  analysis.domain = {
    hasTargetDomain: false,
    targetDomains: [],
    unassignedAnchors: ["test:catalog"],
  };
  analysis.quality.changedFunctions = [{ anchor: "test:catalog" }];
  const classification = profile(["excubitor.catalog.yaml", "test/catalog.test.mjs"]);
  // Taken from the real classifier rather than set by hand, so the test fails if
  // the flag stops being derived from the changed paths.
  assert.equal(classification.codeDomainRequired, false);
  const risk = assessMergeRisk({
    classification,
    analysis,
    leakage: { totalFindings: 0 },
    ci: [],
    runtimeVerification: { required: false, score: 0 },
  });
  assert.equal(pointsFor(risk, "missing_domain"), 0);
});

test("an advised skip is priced as reduced confidence", () => {
  const classification = profile(["README.md"], "+++ b/README.md\n+x\n");
  const base = {
    classification,
    analysis: CLEAN_ANALYSIS,
    leakage: { totalFindings: 0 },
    ci: [],
    runtimeVerification: { required: false, score: 0 },
    docsOnly: true,
  };
  const full = assessMergeRisk(base);
  const thinned = assessMergeRisk({
    ...base,
    plan: { advisedSkips: [{ id: "registered_tests", reason: "文章だけ" }] },
  });
  assert.equal(thinned.score, full.score + 3);
});

test("bands are ordered low, moderate, high, critical", () => {
  assert.equal(riskBandOf(0).band, "low");
  assert.equal(riskBandOf(20).band, "low");
  assert.equal(riskBandOf(21).band, "moderate");
  assert.equal(riskBandOf(45).band, "moderate");
  assert.equal(riskBandOf(46).band, "high");
  assert.equal(riskBandOf(76).band, "critical");
});
