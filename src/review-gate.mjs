import { isDocsOnlyChange, isDocsOrConfigOnlyChange } from "./change-classification.mjs";
import { codeAnalysisGating } from "./review-plan.mjs";
import { GENIUS_HUMAN_DECISION_REASON } from "./human-decision.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:398caf0c */
import augurContract_56a3282f from '../contracts/gate-outcome-japanese-messages.contract.mjs'; /* augur-inject:contract-predicate:96346688 */

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
  domainReviewEnabled = true,
) {
  return domainReviewEnabled
    && !analysis.domain.hasTargetDomain
    && codeDomainRequired
    && !docsOrConfigOnly
    && hasAnalyzableChangedAnchors(analysis);
}

// Anatomia's dual-layer domain gate (spec/feature/domain-dual-layer.md) reports
// a program layer (`analysis.domain.dualLayer`: changed anchors without a
// program domain) and a business layer (`analysis.spec.dualLayer`: changed spec
// clauses no business domain owns). Both carry `wouldBlock` regardless of mode
// and `blocking` only when Anatomia ran enforced. During the migration the
// verdict is surfaced as an advisory next to the legacy target-domain check so
// the two can be compared; it becomes a merge-blocking reason only when the
// caller asked Anatomia to enforce it. An analysis without the field (an older
// Anatomia) is left alone.
export function dualLayerFindings(analysis) {
  const findings = [];
  const program = analysis?.domain?.dualLayer;
  if (program && program.wouldBlock === true) {
    const count = Array.isArray(program.unclassifiedAnchors) ? program.unclassifiedAnchors.length : 0;
    findings.push({
      message: `Anatomia 二層ドメイン（プログラム）: ${count} 件の変更アンカーが未分類`,
      blocking: program.mode === "enforced" && program.blocking === true,
    });
  }
  const business = analysis?.spec?.dualLayer;
  if (business && business.wouldBlock === true) {
    const count = Array.isArray(business.unownedClauses) ? business.unownedClauses.length : 0;
    findings.push({
      message: `Anatomia 二層ドメイン（業務）: ${count} 件の仕様条項が未所有`,
      blocking: business.mode === "enforced" && business.blocking === true,
    });
  }
  return findings;
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
  domainReviewEnabled = true,
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
    reasons.push(`${failedTests.length} 件の登録テストが失敗しました`);
  }
  const skippedTests = ci.filter((test) => test.status === "skipped");
  if (skippedTests.length > 0) {
    advisories.push(
      `${skippedTests.length} 件の登録テストはレビュー計画に不要なため省略しました`,
    );
  }
  // needsTargetDomain stays the only place that decides whether the domain is
  // still owed; the gate only chooses where to record it.
  if (!domainReviewEnabled) {
    advisories.push("Anatomia ドメインレビューはコスト検証モードのため省略しました");
  } else if (needsTargetDomain(finalAnalysis, docsOrConfigOnly, codeDomainRequired)) {
    reasons.push("対象ドメインが未設定です");
  } else if (!finalAnalysis.domain.hasTargetDomain) {
    // The relaxations overlap — a docs/config-only change is also a non-code
    // change and also has no analyzable anchors — so the most specific wording
    // is reported first: docs/config, then non-code, then the unanalyzable
    // surface (a code change Anatomia could not parse), which is the narrowest.
    advisories.push(
      docsOrConfigOnly
        ? `対象ドメインは不要です（${docsOnly ? "ドキュメントのみ" : "ドキュメント／設定のみ"}の変更）`
        : !codeDomainRequired
        ? "対象ドメインは不要です（プロダクションコードの変更なし）"
        : "対象ドメインは不要です（解析可能な変更関数なし）",
    );
  }
  // The dual-layer verdict is part of the domain review, so a plan that skips
  // the domain review skips it as well instead of re-raising it under a new name.
  if (domainReviewEnabled) {
    for (const finding of dualLayerFindings(finalAnalysis)) {
      (finding.blocking ? reasons : advisories).push(finding.message);
    }
  }
  if (finalAnalysis.quality.changedOrphans.length > 0) {
    advisories.push(
      `${finalAnalysis.quality.changedOrphans.length} 件の変更関数が孤立しています`,
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
    reasons.push(`Anatomia ゲートが失敗しました: ${blockingGates.join(", ")}`);
  }
  if (advisoryGates.length > 0) {
    advisories.push(`Anatomia ゲートで所見があります: ${advisoryGates.join(", ")}`);
  }
  const changedViolations = finalAnalysis.architecture.changedViolations;
  const blockingViolations = changedViolations
    .filter((violation) => violation.severity === "error");
  if (blockingViolations.length > 0 && codeAnalysis) {
    reasons.push(`${blockingViolations.length} 件の変更アーキテクチャルール違反が残っています`);
  }
  const advisoryViolations = codeAnalysis
    ? changedViolations.length - blockingViolations.length
    : changedViolations.length;
  if (advisoryViolations > 0) {
    advisories.push(`${advisoryViolations} 件の非ブロックのアーキテクチャルール違反が残っています`);
  }
  // Complexity is a refactoring suggestion, never a merge prerequisite.
  if (typeof complexityScoreDelta === "number" && complexityScoreDelta <= -threshold) {
    advisories.push(`複雑度スコアが ${Math.abs(complexityScoreDelta)} ポイント低下しました`);
  }
  if (humanReviewRequired) {
    reasons.push(GENIUS_HUMAN_DECISION_REASON);
  } else if (reviewerOutput.includes("PR_GATE_NEEDS_HUMAN")) {
    reasons.push("レビュアーが安全なドメイン／仕様定義に必要な情報が不足していると報告しました");
  }
  if (leakage.totalFindings > 0) {
    reasons.push(`${leakage.totalFindings} 件の情報流出候補が残っています`);
  }
  if (security) {
    if (security.status === "findings") {
      reasons.push(
        `${security.totalFindings} 件の '${security.failOnSeverity}' 以上のセキュリティ所見`
        + (security.reason ? ` (${security.reason})` : ""),
      );
    } else if (security.status === "error") {
      // An incomplete scan must not read as a passing policy.
      reasons.push(`セキュリティスキャンが完了しませんでした: ${security.reason}`);
    } else if (security.status === "skipped") {
      if (security.reason !== "disabled by settings") {
        advisories.push(`セキュリティスキャンは省略しました: ${security.reason}`);
      }
    } else if (security.status !== "passed") {
      // Symmetric with the pre-merge check in local-merge.mjs: only a pass or a
      // deliberate skip is a pass. A status the policy cannot read must not fall
      // through the chain silently and leave the PR at Open / Test OK.
      reasons.push("セキュリティスキャンの結果を利用できません");
    }
  }
  return { reasons, advisories };
}
// @ts-expect-error augur-inject
gateOutcome = contract(gateOutcome, { ...augurContract_56a3282f, contractId: 'C-8', mode: 'observe', sample: 1, where: 'src/review-gate.mjs:122', rule: 'contract-wrap', id: '56a3282f' }); /* augur-inject:contract-wrap:56a3282f */
