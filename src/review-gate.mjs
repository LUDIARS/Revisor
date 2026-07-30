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
const ADVISORY_GATES = new Set(["spec_linkage", "coupling_delta"]);

// Documentation is itself the domain of a docs-only change, so a missing code
// target domain must not block the merge (neco 2026-07-30). The domain review
// itself still runs; only the gate is relaxed to an advisory.
const DOC_FILE = /\.(md|markdown|mdx|txt|adoc|rst)$/i;

export function isDocsOnlyChange(changedPaths) {
  return changedPaths.length > 0 && changedPaths.every((path) => DOC_FILE.test(path));
}

// One definition of "this change still owes a code target domain", shared by the
// merge gate, the reviewer prompt, and the human question, so the relaxation can
// never apply to one of them and not the others.
export function needsTargetDomain(analysis, docsOnly = false) {
  return !analysis.domain.hasTargetDomain && !docsOnly;
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
  security,
}) {
  const reasons = [];
  const advisories = [];
  const failedTests = ci.filter((test) => test.status !== "passed");
  if (failedTests.length > 0) {
    reasons.push(`${failedTests.length} registered test case(s) failed`);
  }
  // needsTargetDomain stays the only place that decides whether the domain is
  // still owed; the gate only chooses where to record it.
  if (needsTargetDomain(finalAnalysis, docsOnly)) {
    reasons.push("target domain is still missing");
  } else if (!finalAnalysis.domain.hasTargetDomain) {
    advisories.push("target domain is still missing (docs-only change)");
  }
  if (finalAnalysis.quality.changedOrphans.length > 0) {
    advisories.push(
      `${finalAnalysis.quality.changedOrphans.length} changed function(s) are orphaned`,
    );
  }
  const failedGates = failedGateNames(finalAnalysis.architecture.verify);
  const blockingGates = failedGates.filter((gate) => !ADVISORY_GATES.has(gate));
  const advisoryGates = failedGates.filter((gate) => ADVISORY_GATES.has(gate));
  if (blockingGates.length > 0) {
    reasons.push(`Anatomia gate(s) did not pass: ${blockingGates.join(", ")}`);
  }
  if (advisoryGates.length > 0) {
    advisories.push(`Anatomia gate(s) did not pass: ${advisoryGates.join(", ")}`);
  }
  const changedViolations = finalAnalysis.architecture.changedViolations;
  const blockingViolations = changedViolations
    .filter((violation) => violation.severity === "error");
  if (blockingViolations.length > 0) {
    reasons.push(`${blockingViolations.length} changed architecture rule violation(s) remain`);
  }
  const advisoryViolations = changedViolations.length - blockingViolations.length;
  if (advisoryViolations > 0) {
    advisories.push(`${advisoryViolations} non-blocking architecture rule violation(s) remain`);
  }
  if (complexityScoreDelta <= -threshold) {
    reasons.push(`complexity score dropped by ${Math.abs(complexityScoreDelta)} points`);
  }
  if (reviewerOutput.includes("PR_GATE_NEEDS_HUMAN")) {
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

