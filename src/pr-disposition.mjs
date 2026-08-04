import { riskBandOf } from "./merge-risk.mjs";

// The dashboard's central question is "which of these needs me?". That answer is
// derived at read time, not stored, so moving the risk threshold immediately
// re-sorts and re-colours the list without re-reviewing anything.

export const DECISION_STATES = {
  needs_human: { order: 0, label: "人間の判断が必要", tone: "bad" },
  failed: { order: 1, label: "審査が失敗", tone: "bad" },
  in_review: { order: 2, label: "審査中", tone: "warn" },
  auto_ok: { order: 3, label: "自動マージ可", tone: "ok" },
  merged: { order: 4, label: "マージ済み", tone: "idle" },
  closed: { order: 5, label: "取り下げ", tone: "idle" },
};

// Named for what it does rather than what it returns: a `*State` name reads to
// Anatomia's builtin state-machine domain as a state node that only transition
// functions may reach, and this is a classifier, not a state node.
function classifyDecision(pullRequest, blockers) {
  if (pullRequest.status === "merged") return "merged";
  // 取り下げは終局。 審査結果が何であれ、 もう誰も判断しなくてよい。
  if (pullRequest.status === "closed") return "closed";
  if (pullRequest.checkStatus === "queued" || pullRequest.checkStatus === "running") {
    return "in_review";
  }
  if (pullRequest.checkStatus === "failed") return "failed";
  if (pullRequest.checkStatus !== "test_ok") return "needs_human";
  return blockers.length > 0 ? "needs_human" : "auto_ok";
}

function blockersOf(pullRequest, thresholds) {
  const blockers = [];
  // A worker failure leaves its message on `error` rather than in `reasons`, and
  // it is the only thing that explains the card, so it belongs in the list too.
  if (pullRequest.checkStatus === "failed" && pullRequest.error) {
    blockers.push(String(pullRequest.error));
  }
  if (pullRequest.mergeError) blockers.push(String(pullRequest.mergeError));
  if (pullRequest.draft === true) blockers.push("draft のままです");
  for (const reason of pullRequest.reasons ?? []) blockers.push(reason);
  if (pullRequest.humanQuestion) blockers.push(pullRequest.humanQuestion);
  const risk = pullRequest.mergeRisk;
  if (risk && typeof risk.score === "number" && risk.score > thresholds.riskThreshold) {
    blockers.push(
      `マージリスク ${risk.score} が閾値 ${thresholds.riskThreshold} を超えています`,
    );
  }
  if (
    thresholds.requireRuntimeVerificationClear
    && pullRequest.runtimeVerification?.required
  ) {
    blockers.push("人間による動作確認が必要です");
  }
  return blockers;
}

export function decidePullRequest(pullRequest, {
  autoMergeEnabled = false,
  autoMergeRiskThreshold = 15,
  autoMergeRequiresRuntimeVerificationClear = true,
} = {}) {
  const thresholds = {
    riskThreshold: autoMergeRiskThreshold,
    requireRuntimeVerificationClear: autoMergeRequiresRuntimeVerificationClear,
  };
  // Blockers are collected for every settled review, not only the passing ones:
  // an `action_required` or `failed` card is exactly the card a human is being
  // asked to look at, so it has to say why on the board instead of hiding the
  // reasons behind the detail pane.
  const settled = pullRequest.status !== "merged"
    && pullRequest.status !== "closed"
    && pullRequest.checkStatus !== "queued"
    && pullRequest.checkStatus !== "running";
  const blockers = settled ? blockersOf(pullRequest, thresholds) : [];
  const state = classifyDecision(pullRequest, blockers);
  const score = pullRequest.mergeRisk?.score ?? null;
  const band = typeof score === "number" ? riskBandOf(score) : null;
  return {
    ...pullRequest,
    decision: {
      state,
      label: DECISION_STATES[state].label,
      tone: DECISION_STATES[state].tone,
      order: DECISION_STATES[state].order,
      blockers,
      riskScore: score,
      riskBand: band?.band ?? null,
      riskBandLabel: band?.label ?? null,
      riskThreshold: autoMergeRiskThreshold,
      runtimeVerificationRequired: pullRequest.runtimeVerification?.required === true,
      autoMergeEnabled,
      // Eligibility is the same predicate the automatic merge uses, so the badge
      // never claims something the merge path would refuse.
      autoMergeEligible: autoMergeEnabled
        && state === "auto_ok"
        && pullRequest.status === "open",
    },
  };
}

// Human attention first, then the riskiest, then the most recently updated. A
// queue that buries the one PR needing a decision under twenty green ones is the
// problem this ordering exists to remove.
export function compareByHumanAttention(left, right) {
  const byState = left.decision.order - right.decision.order;
  if (byState !== 0) return byState;
  const byRisk = (right.decision.riskScore ?? -1) - (left.decision.riskScore ?? -1);
  if (byRisk !== 0) return byRisk;
  return String(right.updatedAt).localeCompare(String(left.updatedAt));
}

export function decidePullRequests(pullRequests, settings) {
  return pullRequests
    .map((pullRequest) => decidePullRequest(pullRequest, settings))
    .sort(compareByHumanAttention);
}
