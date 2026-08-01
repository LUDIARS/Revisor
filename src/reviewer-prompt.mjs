import { RUNTIME_CHECK_MARKER } from "./merge-risk.mjs";
import {
  hasAnalyzableChangedAnchors,
  needsTargetDomain,
} from "./review-gate.mjs";
import { stageEnabled } from "./review-plan.mjs";

// A docs-only or configuration-only change must not be asked for a code domain:
// the reviewer would report PR_GATE_NEEDS_HUMAN, which blocks the merge and would
// undo the relaxation the gate just made for exactly this case.
export function domainInstruction({ analysis, docsOnly, docsOrConfigOnly = docsOnly }) {
  if (needsTargetDomain(analysis, docsOrConfigOnly)) {
    return [
      "Anatomia found no target domain for the changed functions.",
      "Infer the target domain from the PR diff and optional original-session context.",
      "Add or update both an AIFormat-compatible spec and the minimal .anatomia/domains membership definition so the changed functions are attributable.",
      "Do not invent a domain if the context is insufficient; include PR_GATE_NEEDS_HUMAN in your final response.",
    ].join(" ");
  }
  if (docsOrConfigOnly) {
    return [
      docsOnly
        ? "This change touches documentation files only, so documentation is its own domain."
        : "This change touches documentation and configuration files only, which declare settings rather than behaviour and own no code domain.",
      "Do not add a code domain or .anatomia/domains membership for it, and do not report PR_GATE_NEEDS_HUMAN for a missing target domain.",
      docsOnly
        ? "Do check that the documentation stays consistent with the specs and behaviour it describes."
        : "Do check that the changed values stay consistent with the specs, schemas and behaviour that read them.",
    ].join(" ");
  }
  // Checked after the docs/config relaxation: a docs-only change has no
  // analyzable anchors either, and its own instruction is the accurate one.
  if (!analysis.domain.hasTargetDomain && !hasAnalyzableChangedAnchors(analysis)) {
    return [
      "Anatomia found no analyzable changed functions, so its function-level domain membership cannot identify a target domain for this change.",
      "Review the executable script or other unsupported surface normally, including its spec boundary and runtime risk.",
      "Do not invent a code anchor or report PR_GATE_NEEDS_HUMAN merely because a target domain is absent.",
    ].join(" ");
  }
  return "Ensure the existing target-domain and spec traceability remains accurate.";
}

// The reviewer is the only party that reads the change with intent in mind, so it
// is the right place to ask whether a human still has to run the product. The
// answer feeds the runtime-verification score, not a free-text note nobody reads.
function runtimeCheckInstruction() {
  return [
    "Judge whether the registered automated tests can establish that this change works.",
    `If a human has to start, drive, or visually inspect the product to know it works, include ${RUNTIME_CHECK_MARKER} in your final response and state in one sentence what has to be exercised.`,
    `If the registered tests are sufficient evidence, do not include ${RUNTIME_CHECK_MARKER}.`,
  ].join(" ");
}

function securityInstruction() {
  return "Perform a vulnerability review: injection, authentication and authorization gaps, unsafe deserialization, path traversal, command execution, unvalidated redirects, and dependency risk introduced by this diff.";
}

// Information-leakage review is unconditional. It is the reason this workflow
// keeps branches local, so no plan may drop it from the prompt.
function leakageInstruction(leakage) {
  return [
    "Explicitly check for information leakage: credentials, personal data, private endpoints, session transcripts, logs, local configuration, and proprietary artifacts that should not enter the repository.",
    `Local high-confidence leakage scan (contains locations only, never matched values):\n${JSON.stringify(leakage, null, 2)}`,
  ].join("\n\n");
}

function planInstruction(plan) {
  const skipped = plan.stages.filter((stage) => stage.run === false);
  if (skipped.length === 0) return null;
  return [
    "The control plan judged the following checks unnecessary for this change; do not spend effort on them:",
    ...skipped.map((stage) => `- ${stage.id}: ${stage.reason}`),
  ].join("\n");
}

export function buildReviewerPrompt({
  request,
  analysis,
  authorContext,
  unifiedDiff,
  leakage,
  docsOnly = false,
  docsOrConfigOnly = docsOnly,
  plan = null,
}) {
  return [
    `Review and autofix PR ${request.repository}#${request.number}.`,
    `Compare the checked-out HEAD with ${request.baseRef}.`,
    "You may read and edit files only. Do not run repository code, install dependencies, use network access, commit, or push; Revisor owns local Git and CI operations.",
    "Perform a normal correctness and maintainability review and directly fix actionable issues.",
    stageEnabled(plan, "security_review") ? securityInstruction() : null,
    leakageInstruction(leakage),
    "Preserve existing user changes and keep edits scoped to this PR.",
    `Anatomia temporary analysis (may be truncated):\n${JSON.stringify(analysis, null, 2).slice(0, 80_000)}`,
    `Unified PR diff (may be truncated):\n${unifiedDiff}`,
    domainInstruction({ analysis, docsOnly, docsOrConfigOnly }),
    stageEnabled(plan, "anatomia_code_analysis")
      ? "Resolve newly orphaned functions and avoid a material complexity-score regression where practical."
      : null,
    runtimeCheckInstruction(),
    plan ? planInstruction(plan) : null,
    `Original author provider: ${authorContext?.provider ?? "(unavailable; configured fallback reviewer is in use)"}`,
    `Original session context:\n${authorContext?.text || "(Concordia unavailable or no matching session; review from PR evidence only)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
