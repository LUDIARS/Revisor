// Spec traceability is reported, never merge-blocking: most repositories have
// no complete Anatomia spec linkage yet, and blocking on it stops every PR
// without protecting the goals this workflow exists for (keeping branches off
// the remote and catching information leakage).
const ADVISORY_GATES = new Set(["spec_linkage"]);

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
}) {
  const reasons = [];
  const advisories = [];
  const failedTests = ci.filter((test) => test.status !== "passed");
  if (failedTests.length > 0) {
    reasons.push(`${failedTests.length} registered test case(s) failed`);
  }
  if (!finalAnalysis.domain.hasTargetDomain) reasons.push("target domain is still missing");
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
  return { reasons, advisories };
}

