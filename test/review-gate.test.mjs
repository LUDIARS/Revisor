import assert from "node:assert/strict";
import test from "node:test";
import {
  gateOutcome,
  hasAnalyzableChangedAnchors,
  isDocsOnlyChange,
  isDocsOrConfigOnlyChange,
  needsTargetDomain,
} from "../src/review-gate.mjs";

function analysis({ gates = [], changedOrphans = [], changedViolations = [] } = {}) {
  return {
    domain: {
      hasTargetDomain: true,
      targetDomains: [{ name: "review-gate", changedAnchors: ["fn:changed"] }],
      unassignedAnchors: [],
    },
    quality: {
      changedFunctions: [{ anchor: "fn:changed" }],
      changedOrphans,
      complexity: { score: 70 },
    },
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

test("reports coupling_delta without blocking the merge (environment-dependent gate)", () => {
  const outcome = evaluate(analysis({
    gates: [
      { gate: "rule_conformance", pass: true },
      { gate: "coupling_delta", pass: false },
    ],
  }));
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, ["Anatomia gate(s) did not pass: coupling_delta"]);
});

test("reports convention_drift without blocking the merge (Anatomia declares it warn)", () => {
  const outcome = evaluate(analysis({
    gates: [
      { gate: "rule_conformance", pass: true },
      { gate: "convention_drift", pass: false },
    ],
  }));
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, ["Anatomia gate(s) did not pass: convention_drift"]);
});

// Anatomia の block 相当ゲートは advisory に落とさない。 warn ゲートを通す変更が
// block ゲートまで緩めていないことを固定する。
test("keeps Anatomia block-severity gates blocking alongside the warn ones", () => {
  const outcome = evaluate(analysis({
    gates: [
      { gate: "duplication", pass: false },
      { gate: "convention_drift", pass: false },
      { gate: "coupling_delta", pass: false },
      { gate: "spec_linkage", pass: false },
    ],
  }));
  assert.deepEqual(outcome.reasons, ["Anatomia gate(s) did not pass: duplication"]);
  assert.deepEqual(outcome.advisories, [
    "Anatomia gate(s) did not pass: convention_drift, coupling_delta, spec_linkage",
  ]);
});

// advisory 集合は名前の再掲なので、 Anatomia 側にゲートが増えたときは
// 未知の名前としてブロック側に落ちる (fail-closed) ことを固定する。
test("blocks on a gate name the advisory set does not know", () => {
  const outcome = evaluate(analysis({
    gates: [{ gate: "some_new_upstream_gate", pass: false }],
  }));
  assert.deepEqual(outcome.reasons, ["Anatomia gate(s) did not pass: some_new_upstream_gate"]);
  assert.deepEqual(outcome.advisories, []);
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

test("records a skipped domain review without blocking the merge", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  finalAnalysis.domain.targetDomains = [];
  const outcome = evaluate(finalAnalysis, { domainReviewEnabled: false });
  assert.deepEqual(outcome.reasons, []);
  assert.match(outcome.advisories[0], /domain review was skipped/);
  assert.equal(needsTargetDomain(finalAnalysis, false, true, false), false);
});

test("passes a clean analysis with no advisories", () => {
  const outcome = evaluate(analysis());
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, []);
});

test("blocks a code change whose target domain is missing", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  finalAnalysis.domain.targetDomains = [];
  finalAnalysis.domain.unassignedAnchors = ["fn:changed"];
  const outcome = evaluate(finalAnalysis);
  assert.deepEqual(outcome.reasons, ["target domain is still missing"]);
  assert.deepEqual(outcome.advisories, []);
});

test("does not demand a function domain when Anatomia reports no changed anchors", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain = {
    hasTargetDomain: false,
    targetDomains: [],
    unassignedAnchors: [],
  };
  finalAnalysis.quality.changedFunctions = [];
  const outcome = evaluate(finalAnalysis);
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "target domain is not applicable (no analyzable changed functions)",
  ]);
  assert.equal(needsTargetDomain(finalAnalysis), false);
});

test("only an explicit zero-anchor analysis relaxes the requirement", () => {
  // A docs-only diff carries no changed functions either, so a payload that
  // still claims an anchor anywhere has to keep the gate closed.
  const bothEmpty = analysis();
  bothEmpty.domain = { hasTargetDomain: false, targetDomains: [], unassignedAnchors: [] };
  bothEmpty.quality.changedFunctions = [];
  assert.equal(hasAnalyzableChangedAnchors(bothEmpty), false);

  const qualityOnly = structuredClone(bothEmpty);
  qualityOnly.quality.changedFunctions = [{ anchor: "fn:changed" }];
  assert.equal(hasAnalyzableChangedAnchors(qualityOnly), true);

  const domainOnly = structuredClone(bothEmpty);
  domainOnly.domain.unassignedAnchors = ["fn:changed"];
  assert.equal(hasAnalyzableChangedAnchors(domainOnly), true);

  const assignedOnly = structuredClone(bothEmpty);
  assignedOnly.domain.targetDomains = [{ name: "review-gate", changedAnchors: ["fn:changed"] }];
  assert.equal(hasAnalyzableChangedAnchors(assignedOnly), true);

  // Neither signal present: an older or malformed payload stays fail-closed.
  assert.equal(hasAnalyzableChangedAnchors({ domain: { hasTargetDomain: false } }), true);
  assert.equal(hasAnalyzableChangedAnchors({}), true);
});

test("the docs-only relaxation is reported ahead of the unanalyzable-surface one", () => {
  // A docs-only change has no analyzable anchors, so both relaxations apply; the
  // advisory must still name the reason the reader can act on.
  const finalAnalysis = analysis();
  finalAnalysis.domain = { hasTargetDomain: false, targetDomains: [], unassignedAnchors: [] };
  finalAnalysis.quality.changedFunctions = [];
  const outcome = evaluate(finalAnalysis, { docsOnly: true });
  assert.deepEqual(outcome.advisories, [
    "target domain is still missing (docs-only change)",
  ]);
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

test("relaxes a missing target domain to an advisory for a config-only change", () => {
  // Settings files declare no behaviour, so they can never gain a target domain:
  // without this the one-line catalog edit in Genius#6 stays unmergeable forever.
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  const outcome = evaluate(finalAnalysis, { docsOrConfigOnly: true });
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "target domain is still missing (docs/config-only change)",
  ]);
});

test("does not require an application domain for a non-code change with test anchors", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  finalAnalysis.domain.targetDomains = [];
  finalAnalysis.domain.unassignedAnchors = ["test:catalog"];
  finalAnalysis.quality.changedFunctions = [{ anchor: "test:catalog" }];
  const outcome = evaluate(finalAnalysis, { codeDomainRequired: false });
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "target domain is not applicable (no production code change)",
  ]);
  assert.equal(needsTargetDomain(finalAnalysis, false, false), false);
});

test("a docs/config-only change keeps its advisory over the generic non-code one", () => {
  const finalAnalysis = analysis();
  finalAnalysis.domain.hasTargetDomain = false;
  finalAnalysis.domain.targetDomains = [];
  finalAnalysis.domain.unassignedAnchors = [];
  finalAnalysis.quality.changedFunctions = [];
  const outcome = evaluate(finalAnalysis, {
    docsOrConfigOnly: true,
    codeDomainRequired: false,
  });
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "target domain is still missing (docs/config-only change)",
  ]);
});

test("the config-only relaxation covers the missing domain and nothing else", () => {
  const finalAnalysis = analysis({ gates: [{ gate: "rule_conformance", pass: false }] });
  finalAnalysis.domain.hasTargetDomain = false;
  const outcome = evaluate(finalAnalysis, {
    docsOrConfigOnly: true,
    ci: [{ name: "unit", status: "failed" }],
    reviewerOutput: "PR_GATE_NEEDS_HUMAN",
    leakage: { totalFindings: 2 },
    complexityScoreDelta: -14,
    security: { status: "findings", totalFindings: 1, failOnSeverity: "high" },
  });
  assert.deepEqual(outcome.reasons, [
    "1 registered test case(s) failed",
    "Anatomia gate(s) did not pass: rule_conformance",
    "complexity score dropped by 14 points",
    "reviewer reported insufficient information for a safe domain/spec definition",
    "2 potential information leakage finding(s) remain",
    "1 security finding(s) at or above 'high'",
  ]);
  assert.equal(
    outcome.reasons.includes("target domain is still missing"),
    false,
  );
});

test("isDocsOrConfigOnlyChange accepts documentation and settings files only", () => {
  assert.equal(isDocsOrConfigOnlyChange(["excubitor.catalog.yaml"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["revisor.config.json"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["README.md", "config/app.yml"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["config/app.yml", "src/runner.mjs"]), false);
  assert.equal(isDocsOrConfigOnlyChange([]), false);
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

test("needsTargetDomain follows the docs/config-only relaxation", () => {
  const withDomain = analysis();
  const withoutDomain = structuredClone(withDomain);
  withoutDomain.domain.hasTargetDomain = false;
  withoutDomain.domain.targetDomains = [];
  withoutDomain.domain.unassignedAnchors = ["fn:changed"];
  assert.equal(needsTargetDomain(withoutDomain), true);
  assert.equal(needsTargetDomain(withoutDomain, true), false);
  assert.equal(needsTargetDomain(withDomain), false);
  assert.equal(needsTargetDomain(withDomain, true), false);
});

test("a plan that drops code analysis downgrades its gates to advisories", () => {
  const skipped = {
    stages: [{ id: "anatomia_code_analysis", run: false, reason: "実行コードを含まない変更です" }],
  };
  const subject = analysis({
    gates: [{ gate: "rule_conformance", pass: false }],
    changedViolations: [{ severity: "error", rule: "layering" }],
  });
  const blocked = evaluate(subject);
  assert.equal(blocked.reasons.length > 0, true);
  const relaxed = evaluate(subject, { plan: skipped });
  assert.deepEqual(relaxed.reasons, []);
  assert.equal(
    relaxed.advisories.some((entry) => entry.includes("rule_conformance")),
    true,
  );
  assert.equal(
    relaxed.advisories.some((entry) => entry.includes("architecture rule violation")),
    true,
  );
});

test("a control planner cannot demote a blocking architecture error to an advisory", () => {
  // The stage is off exactly as above, but this time a control planner asked for
  // it. The head analysis ran either way, so the findings are real evidence and
  // the gate must still block — otherwise an LLM's plan silences the merge gate.
  const advised = {
    stages: [{ id: "anatomia_code_analysis", run: false, reason: "小さい変更なので不要 (管制プランナー判断)" }],
    advisedSkips: [{ id: "anatomia_code_analysis", reason: "小さい変更なので不要" }],
  };
  const outcome = evaluate(
    analysis({
      gates: [{ gate: "rule_conformance", pass: false }],
      changedViolations: [{ severity: "error", rule: "layering" }],
    }),
    { plan: advised },
  );
  assert.equal(
    outcome.reasons.some((entry) => entry.includes("rule_conformance")),
    true,
  );
  assert.equal(
    outcome.reasons.some((entry) => entry.includes("architecture rule violation")),
    true,
  );
});

test("a complexity delta that was never measured cannot block", () => {
  const outcome = evaluate(analysis(), { complexityScoreDelta: null });
  assert.deepEqual(outcome.reasons, []);
});

test("a test case the plan did not require is an advisory, not a failure", () => {
  const outcome = evaluate(analysis(), {
    ci: [
      { name: "unit", status: "passed" },
      { name: "smoke", status: "skipped", reason: "変更種別を担当しません" },
    ],
  });
  assert.deepEqual(outcome.reasons, []);
  assert.equal(
    outcome.advisories.some((entry) => entry.includes("not required by the review plan")),
    true,
  );
});

test("Genius review guidance always leaves the final decision to a human", () => {
  const outcome = evaluate(analysis(), { humanReviewRequired: true });
  assert.ok(outcome.reasons.includes("Genius judgment cards require a human decision"));
});

test("blocks on security findings and on an incomplete security scan", () => {
  const findings = evaluate(analysis(), {
    security: { status: "findings", totalFindings: 3, failOnSeverity: "high" },
  });
  assert.deepEqual(findings.reasons, ["3 security finding(s) at or above 'high'"]);
  const incomplete = evaluate(analysis(), {
    security: { status: "error", reason: "codex-security exited with code 2" },
  });
  assert.deepEqual(incomplete.reasons, [
    "the security scan did not complete: codex-security exited with code 2",
  ]);
});

test("treats a skipped security scan as advisory and a disabled one as silent", () => {
  const skipped = evaluate(analysis(), {
    security: { status: "skipped", reason: "registered tests failed" },
  });
  assert.deepEqual(skipped.reasons, []);
  assert.deepEqual(skipped.advisories, [
    "security scan skipped: registered tests failed",
  ]);
  const disabled = evaluate(analysis(), {
    security: { status: "skipped", reason: "disabled by settings" },
  });
  assert.deepEqual(disabled.reasons, []);
  assert.deepEqual(disabled.advisories, []);
  const passed = evaluate(analysis(), {
    security: { status: "passed", totalFindings: 0, failOnSeverity: "high" },
  });
  assert.deepEqual(passed.reasons, []);
  assert.deepEqual(passed.advisories, []);
});

test("blocks on a security result the policy cannot read", () => {
  // Same fail-closed rule as the pre-merge check, so a status the gate does not
  // know cannot pass here and then block at merge time.
  const unknown = evaluate(analysis(), { security: { status: "queued" } });
  assert.deepEqual(unknown.reasons, ["the security scan produced no usable result"]);
  const empty = evaluate(analysis(), { security: {} });
  assert.deepEqual(empty.reasons, ["the security scan produced no usable result"]);
});

// --- Anatomia dual-layer domain gate (advisory by default, enforced by flag) ---

function dualLayer(mode, { unclassifiedAnchors = [], unownedClauses = [] } = {}) {
  const programWouldBlock = unclassifiedAnchors.length > 0;
  const businessWouldBlock = unownedClauses.length > 0;
  return {
    program: {
      mode,
      pass: !programWouldBlock,
      wouldBlock: programWouldBlock,
      blocking: mode === "enforced" && programWouldBlock,
      unclassifiedAnchors,
      businessUnownedAnchors: [],
    },
    business: {
      mode,
      pass: !businessWouldBlock,
      wouldBlock: businessWouldBlock,
      blocking: mode === "enforced" && businessWouldBlock,
      skippedForDependencyOnlyChange: false,
      unownedClauses,
      programUnrefinedClauses: [],
    },
  };
}

function withDualLayer(base, layers) {
  return {
    ...base,
    domain: { ...base.domain, dualLayer: layers.program },
    spec: { changedFilesWithoutSpec: [], dualLayer: layers.business },
  };
}

test("reports advisory dual-layer findings without blocking the merge", () => {
  const outcome = evaluate(withDualLayer(analysis(), dualLayer("advisory", {
    unclassifiedAnchors: ["fn:a", "fn:b"],
    unownedClauses: [{ id: "c1", sourceFile: "spec/x.md", heading: "X" }],
  })));
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, [
    "Anatomia dual-layer (program): 2 changed anchor(s) unclassified",
    "Anatomia dual-layer (business): 1 spec clause(s) unowned",
  ]);
});

test("promotes dual-layer findings to blocking reasons only when Anatomia ran enforced", () => {
  const outcome = evaluate(withDualLayer(analysis(), dualLayer("enforced", {
    unclassifiedAnchors: ["fn:a"],
  })));
  assert.deepEqual(outcome.reasons, [
    "Anatomia dual-layer (program): 1 changed anchor(s) unclassified",
  ]);
  assert.deepEqual(outcome.advisories, []);
});

test("a passing dual-layer gate adds neither reasons nor advisories", () => {
  const outcome = evaluate(withDualLayer(analysis(), dualLayer("enforced")));
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, []);
});

test("keeps the legacy target-domain verdict alongside the dual-layer advisory", () => {
  const legacy = analysis();
  legacy.domain.hasTargetDomain = false;
  const outcome = evaluate(withDualLayer(legacy, dualLayer("advisory", {
    unclassifiedAnchors: ["fn:changed"],
  })));
  assert.deepEqual(outcome.reasons, ["target domain is still missing"]);
  assert.deepEqual(outcome.advisories, [
    "Anatomia dual-layer (program): 1 changed anchor(s) unclassified",
  ]);
});

test("ignores an analysis from an Anatomia that has no dual-layer gate", () => {
  const outcome = evaluate(analysis());
  assert.equal("dualLayer" in outcome, false);
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, []);
});

test("a skipped domain review also skips the dual-layer verdict", () => {
  const outcome = evaluate(
    withDualLayer(analysis(), dualLayer("enforced", { unclassifiedAnchors: ["fn:a"] })),
    { domainReviewEnabled: false },
  );
  assert.deepEqual(outcome.reasons, []);
  assert.deepEqual(outcome.advisories, ["Anatomia domain review was skipped by cost validation mode"]);
});
