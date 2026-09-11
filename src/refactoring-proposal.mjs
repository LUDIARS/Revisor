/** @implements SPEC-REFACTORING-PROPOSAL
 * Derive an advisory project marker from the latest measured PR evidence.
 * Project isolation uses the uncapped whole-project count, never diff-local arrays.
 */
export const REFACTORING_THRESHOLDS = Object.freeze({
  maximumScore: 50,
  minimumMaximumComplexity: 20,
  minimumProjectOrphans: 5,
});

const FUNCTION_COMPLEXITY_METRIC = "call-out-degree-plus-one";

function measuredFunctionComplexities(quality) {
  const snapshot = quality?.functionComplexity;
  const expectedCount = quality?.complexity?.functions;
  if (snapshot?.version !== 1
    || snapshot.metric !== FUNCTION_COMPLEXITY_METRIC
    || !Array.isArray(snapshot.functions)
    || !Number.isInteger(expectedCount)
    || expectedCount <= 0
    || snapshot.functions.length !== expectedCount
    || !snapshot.functions.every((entry) => Number.isInteger(entry?.value) && entry.value >= 1)) {
    return null;
  }
  return snapshot.functions.map((entry) => entry.value);
}

export function refactoringProposal(pullRequest) {
  const quality = pullRequest?.anatomia?.quality;
  const complexity = quality?.complexity;
  const functionComplexities = measuredFunctionComplexities(quality);
  const measured = functionComplexities !== null && Number.isFinite(complexity?.score);
  const findings = [];
  if (measured && Number.isFinite(complexity.score)
    && complexity.score <= REFACTORING_THRESHOLDS.maximumScore) {
    findings.push(`集計複雑度スコア ${complexity.score} / 100 (提案: ${REFACTORING_THRESHOLDS.maximumScore} 以下)`);
  }
  const maximumFunctionComplexity = functionComplexities === null
    ? null
    : functionComplexities.reduce((maximum, value) => Math.max(maximum, value), 0);
  if (maximumFunctionComplexity !== null
    && maximumFunctionComplexity >= REFACTORING_THRESHOLDS.minimumMaximumComplexity) {
    findings.push(`関数の最大複雑度 ${maximumFunctionComplexity} (呼び出し出次数 + 1、提案: ${REFACTORING_THRESHOLDS.minimumMaximumComplexity} 以上)`);
  }
  const projectOrphans = quality?.projectOrphans;
  const orphansMeasured = projectOrphans?.status === "measured"
    && projectOrphans.scope === "project"
    && Number.isSafeInteger(projectOrphans.count) && projectOrphans.count >= 0;
  if (orphansMeasured && projectOrphans.count >= REFACTORING_THRESHOLDS.minimumProjectOrphans) {
    findings.push(`プロジェクト全体の孤立関数 ${projectOrphans.count} 件 (提案: ${REFACTORING_THRESHOLDS.minimumProjectOrphans} 件以上)`);
  }
  return {
    status: findings.length > 0 ? "suggested" : measured && orphansMeasured ? "clear" : "unmeasured",
    advisory: true,
    findings,
    projectOrphanCount: orphansMeasured ? projectOrphans.count : null,
    projectOrphanStatus: orphansMeasured ? "measured" : "unmeasured",
    sourcePrNumber: pullRequest?.number ?? null,
    sourceHeadSha: pullRequest?.reviewedHeadSha ?? null,
    thresholds: REFACTORING_THRESHOLDS,
  };
}

function completedReview(pr) {
  return pr.status !== "closed" && Boolean(pr.reviewedHeadSha)
    && pr.reviewedHeadSha.toLowerCase() === pr.headSha?.toLowerCase()
    && ["test_ok", "action_required"].includes(pr.checkStatus);
}

// Lifecycle updates (a late merge/close) must not revive older measurements:
// the newest review by creation time wins, then the higher number.
function newestFirst(left, right) {
  return String(right.createdAt).localeCompare(String(left.createdAt))
    || right.number - left.number;
}

/**
 * `proposalOf` lets the caller supply the analysis lazily: list records do not
 * carry `anatomia`, and each one is megabytes, so a repository is scanned newest
 * first and stops at its first measured review.
 */
export function projectRefactoringProposals(
  repositories,
  pullRequests,
  { proposalOf = refactoringProposal } = {},
) {
  const candidates = new Map();
  for (const pr of pullRequests) {
    if (!completedReview(pr)) continue;
    const key = pr.repository.toLowerCase();
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(pr);
  }
  const latest = new Map();
  for (const [key, reviews] of candidates) {
    for (const pr of reviews.sort(newestFirst)) {
      const proposal = proposalOf(pr);
      if (proposal.status === "unmeasured") continue;
      latest.set(key, proposal);
      break;
    }
  }
  return repositories.map((repository) => ({
    ...repository,
    refactoringProposal: latest.get(repository.repository.toLowerCase())
      ?? refactoringProposal(undefined),
  }));
}
