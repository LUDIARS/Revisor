import { decidePullRequest } from "./pr-disposition.mjs";

// Automatic merging answers exactly one question: is this change below the risk
// the human accepted? The predicate is the same one the dashboard badge uses, so
// a PR labelled "自動マージ可" is precisely a PR this function will merge.

export function autoMergeDecision(pullRequest, settings) {
  if (!settings.autoMergeEnabled) {
    return { merge: false, reason: "オートマージは無効です" };
  }
  const decided = decidePullRequest(pullRequest, settings);
  if (decided.status !== "open") {
    return { merge: false, reason: `PR は ${decided.status} です` };
  }
  if (!decided.decision.autoMergeEligible) {
    return {
      merge: false,
      reason: decided.decision.blockers.length > 0
        ? decided.decision.blockers.join(" / ")
        : `状態 ${decided.decision.label} はオートマージ対象外です`,
    };
  }
  return {
    merge: true,
    reason: `マージリスク ${decided.decision.riskScore} が閾値 ${decided.decision.riskThreshold} 以下です`,
  };
}

export function autoMergeRecord({ merged, reason, now = () => new Date().toISOString() }) {
  return { attempted: true, merged, reason, at: now() };
}
