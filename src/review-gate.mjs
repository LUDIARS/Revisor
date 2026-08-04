import { isDocsOnlyChange, isDocsOrConfigOnlyChange } from "./change-classification.mjs";
import { codeAnalysisGating } from "./review-plan.mjs";

// Re-exported because the gate, the reviewer prompt and the human question all
// reach for them through this module; the classification itself lives with the rest
// of the change profile.
export { isDocsOnlyChange, isDocsOrConfigOnlyChange };

// Spec traceability is reported, never merge-blocking: most repositories have
// no complete Anatomia spec linkage yet, and blocking on it stops every PR
// without protecting the goals this workflow exists for (keeping branches off
// the remote and catching information leakage).
//
// coupling_delta is advisory as well (neco 2026-07-30): Anatomia's ephemeral
// pr-review derives its percentile threshold and call graph from the analysis
// environment, and the same commit measured p95=9 (14 functions flagged) in the
// review worktree but p95=9.9 (none flagged) in clean local worktrees
// (Concordia#3). Until that non-determinism is fixed on the Anatomia side
// (issue filed), an environment-dependent verdict must not block merges.
//
// convention_drift is advisory because Anatomia itself declares it
// `severity: "warn"` (src/supply/gates/convention_drift.ts) — it mines naming
// case style and shared affixes from sibling code, so a name that reads fine
// but differs from its siblings is a suggestion, not a defect. Blocking on it
// made Revisor stricter than the analyser that produced the verdict.
//
// This set is exactly Anatomia's warn-severity gates; its block-severity gates
// (rule_conformance, duplication) stay blocking, and so does any gate name not
// listed here, so a gate added upstream fails closed until it is triaged.
// Anatomia does not carry severity in GateResult, so the alignment has to be
// restated here by name. spec_linkage is listed unconditionally: Anatomia
// promotes it to block under strict mode, but Revisor reports traceability
// rather than enforcing it (see above).
const ADVISORY_GATES = new Set(["spec_linkage", "coupling_delta", "convention_drift"]);

// Anatomia derives domain membership from parsed functions, so a change to a
// surface it cannot parse (a .bat entrypoint, say) reports no target domain not
// because one is missing but because there is nothing to attribute. Demanding a
// domain there blocks the change forever, exactly like the docs/config case.
//
// Both available signals are consulted and either one claiming an anchor wins:
// the payload has to say, unambiguously and everywhere, that nothing was
// analysed before the requirement is relaxed. A payload that carries neither
// signal is older or malformed and stays fail-closed.
export function hasAnalyzableChangedAnchors(analysis) {
  const unassigned = analysis?.domain?.unassignedAnchors;
  const targetDomains = analysis?.domain?.targetDomains;
  const changedFunctions = analysis?.quality?.changedFunctions;
  const domainKnown = Array.isArray(unassigned) && Array.isArray(targetDomains);
  const qualityKnown = Array.isArray(changedFunctions);
  if (!domainKnown && !qualityKnown) return true;
  if (
    domainKnown
    && (unassigned.length > 0
      || targetDomains.some((domain) => domain.changedAnchors?.length > 0))
  ) {
    return true;
  }
  return qualityKnown && changedFunctions.length > 0;
}

// One definition of "this change still owes a code target domain", shared by the
// merge gate, the reviewer prompt, and the human question, so the relaxation can
// never apply to one of them and not the others. Documentation, settings, tests,
// operational manifests and generated artifacts carry no application code
// domain of their own, so demanding one blocks the change forever instead of
// improving it. `codeDomainRequired` comes from the deterministic path classifier.
export function needsTargetDomain(
  analysis,
  docsOrConfigOnly = false,
  codeDomainRequired = true,
) {
  return !analysis.domain.hasTargetDomain
    && codeDomainRequired
    && !docsOrConfigOnly
    && hasAnalyzableChangedAnchors(analysis);
}

function failedGateNames(verify) {
  if (!verify || verify.pass) return [];
  const failed = (verify.gates ?? [])
    .filter((gate) => gate.pass === false)
    .map((gate) => gate.gate);
  // A failed verification that names no gate is still a failure, so it must not
  // become a silent pass.
  return failed.length > 0 ? failed : ["unspecified"];
}

export function gateOutcome({
  finalAnalysis,
  complexityScoreDelta,
  threshold,
  reviewerOutput,
  leakage,
  ci,
  docsOnly = false,
  // A docs-only change is always docs/config-only, so the narrower flag alone
  // still selects the relaxation for callers that only know about documentation.
  docsOrConfigOnly = docsOnly,
  codeDomainRequired = true,
  plan = null,
  security,
  humanReviewRequired = false,
}) {
  const reasons = [];
  const advisories = [];
  // When the deterministic plan drops code analysis there is no baseline and the
  // quality and architecture findings are not evidence the plan asked for, so
  // gating on them would block a change on a check that was deliberately not part
  // of its review. They are recorded as advisories instead. A skip a control
  // planner asked for does not relax the gate: see `codeAnalysisGating`.
  const codeAnalysis = codeAnalysisGating(plan);
  const failedTests = ci.filter((test) => test.status === "failed");
  if (failedTests.length > 0) {
    reasons.push(`${failedTests.length} registered test case(s) failed`);
  }
  const skippedTests = ci.filter((test) => test.status === "skipped");
  if (skippedTests.length > 0) {
    advisories.push(
      `${skippedTests.length} registered test case(s) were not required by the review plan`,
    );
  }
  // needsTargetDomain stays the only place that decides whether the domain is
  // still owed; the gate only chooses where to record it.
  if (needsTargetDomain(finalAnalysis, docsOrConfigOnly, codeDomainRequired)) {
    reasons.push("target domain is still missing");
  } else if (!finalAnalysis.domain.hasTargetDomain) {
    // The relaxations overlap — a docs/config-only change is also a non-code
    // change and also has no analyzable anchors — so the most specific wording
    // is reported first: docs/config, then non-code, then the unanalyzable
    // surface (a code change Anatomia could not parse), which is the narrowest.
    advisories.push(
      docsOrConfigOnly
        ? `target domain is still missing (${docsOnly ? "docs-only" : "docs/config-only"} change)`
        : !codeDomainRequired
        ? "target domain is not applicable (no production code change)"
        : "target domain is not applicable (no analyzable changed functions)",
    );
  }
  if (finalAnalysis.quality.changedOrphans.length > 0) {
    advisories.push(
      `${finalAnalysis.quality.changedOrphans.length} changed function(s) are orphaned`,
    );
  }
  const failedGates = failedGateNames(finalAnalysis.architecture.verify);
  const blockingGates = codeAnalysis
    ? failedGates.filter((gate) => !ADVISORY_GATES.has(gate))
    : [];
  const advisoryGates = codeAnalysis
    ? failedGates.filter((gate) => ADVISORY_GATES.has(gate))
    : failedGates;
  if (blockingGates.length > 0) {
    reasons.push(`Anatomia gate(s) did not pass: ${blockingGates.join(", ")}`);
  }
  if (advisoryGates.length > 0) {
    advisories.push(`Anatomia gate(s) did not pass: ${advisoryGates.join(", ")}`);
  }
  const changedViolations = finalAnalysis.architecture.changedViolations;
  const blockingViolations = changedViolations
    .filter((violation) => violation.severity === "error");
  if (blockingViolations.length > 0 && codeAnalysis) {
    reasons.push(`${blockingViolations.length} changed architecture rule violation(s) remain`);
  }
  const advisoryViolations = codeAnalysis
    ? changedViolations.length - blockingViolations.length
    : changedViolations.length;
  if (advisoryViolations > 0) {
    advisories.push(`${advisoryViolations} non-blocking architecture rule violation(s) remain`);
  }
  // A skipped code analysis produces no baseline, so there is no delta to gate on.
  if (typeof complexityScoreDelta === "number" && complexityScoreDelta <= -threshold) {
    reasons.push(`complexity score dropped by ${Math.abs(complexityScoreDelta)} points`);
  }
  if (humanReviewRequired) {
    reasons.push("Genius judgment cards require a human decision");
  } else if (reviewerOutput.includes("PR_GATE_NEEDS_HUMAN")) {
    reasons.push("reviewer reported insufficient information for a safe domain/spec definition");
  }
  if (leakage.totalFindings > 0) {
    reasons.push(`${leakage.totalFindings} potential information leakage finding(s) remain`);
  }
  if (security) {
    if (security.status === "findings") {
      reasons.push(
        `${security.totalFindings} security finding(s) at or above '${security.failOnSeverity}'`
        + (security.reason ? ` (${security.reason})` : ""),
      );
    } else if (security.status === "error") {
      // An incomplete scan must not read as a passing policy.
      reasons.push(`the security scan did not complete: ${security.reason}`);
    } else if (security.status === "skipped") {
      if (security.reason !== "disabled by settings") {
        advisories.push(`security scan skipped: ${security.reason}`);
      }
    } else if (security.status !== "passed") {
      // Symmetric with the pre-merge check in local-merge.mjs: only a pass or a
      // deliberate skip is a pass. A status the policy cannot read must not fall
      // through the chain silently and leave the PR at Open / Test OK.
      reasons.push("the security scan produced no usable result");
    }
  }
  return { reasons, advisories };
}
