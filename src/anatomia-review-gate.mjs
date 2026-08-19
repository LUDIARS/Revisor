import { gateOutcome } from "./review-gate.mjs";
import { stageEnabled } from "./review-plan.mjs";

function unavailableAnalysis(reason) {
  return {
    availability: { status: "unavailable", reason },
    domain: { hasTargetDomain: true, targetDomains: [], unassignedAnchors: [] },
    quality: {
      changedFunctions: [],
      changedOrphans: [],
      complexity: { score: 100, functions: 0 },
    },
    architecture: { verify: { pass: true, gates: [] }, changedViolations: [] },
  };
}

// This gate intentionally consumes the same predicate as the final review
// result. That keeps a blocking Anatomia finding from reaching a model only to
// be reported again after its review has already spent capacity.
export function evaluateAnatomiaReviewGate({ analysis, cliPath, plan, classification }) {
  const { reasons: gateReasons, advisories } = gateOutcome({
    finalAnalysis: analysis,
    complexityScoreDelta: null,
    threshold: Number.POSITIVE_INFINITY,
    reviewerOutput: "",
    leakage: { totalFindings: 0 },
    ci: [],
    docsOnly: classification.docsOnly,
    docsOrConfigOnly: classification.docsOrConfigOnly,
    codeDomainRequired: classification.codeDomainRequired,
    domainReviewEnabled: stageEnabled(plan, "anatomia_domain_review"),
    plan,
    security: null,
  });
  // `changedViolations` are the PR-scoped findings emitted by Anatomia.
  // Preserve each one in the gate reason even when Anatomia labels it as a
  // warning: this front gate is intentionally stricter than the final
  // advisory presentation, because it protects scarce LLM review capacity.
  const violations = (analysis.architecture.changedViolations ?? [])
    .map((violation) => violation.message || violation.rule || "unspecified")
    .slice(0, 20);
  const reasons = [
    ...gateReasons,
    ...violations.map((violation) => `Anatomia changed violation: ${violation}`),
  ];
  return {
    status: reasons.length > 0 ? "blocked" : "passed",
    message: reasons.length > 0
      ? `Anatomia review gate found ${reasons.length} blocking reason(s).`
      : "Anatomia review gate passed.",
    reasons,
    // Non-blocking findings (the advisory dual-layer domain gate among them) ride
    // along so the persisted gate verdict shows what the front gate saw.
    advisories,
    analysis,
    cliPath,
  };
}

export async function runAnatomiaReviewGate({
  enabled,
  resolveCli,
  analyze,
  anatomiaFolder,
  cwd,
  base,
  plan,
  classification,
}) {
  if (!enabled) {
    return {
      status: "disabled",
      message: "Anatomia review gate is disabled by settings.",
      analysis: null,
      cliPath: null,
    };
  }
  let unavailableReason = "Anatomia CLI could not be resolved";
  try {
    const cliPath = await resolveCli(anatomiaFolder);
    unavailableReason = "Anatomia PR analysis failed";
    const analysis = await analyze({ cliPath, cwd, base });
    return evaluateAnatomiaReviewGate({
      analysis,
      cliPath,
      plan,
      classification,
    });
  } catch {
    // Resolver and subprocess errors can contain local paths, command output,
    // private endpoints, or credentials. The gate result is persisted on the
    // PR, so record the failed phase without copying the raw exception.
    return {
      status: "unavailable",
      message: `Anatomia review gate passed through because analysis was unavailable: ${unavailableReason}.`,
      analysis: unavailableAnalysis(unavailableReason),
      cliPath: null,
      reason: unavailableReason,
    };
  }
}
