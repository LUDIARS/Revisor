export const GENIUS_HUMAN_DECISION_REASON =
  "Genius judgment cards require a human decision";

/**
 * True when the only thing holding this PR back is the Genius card confirmation
 * a person is being asked for. Every other blocker keeps it false, so the hold
 * can never be used to acknowledge something else.
 *
 * The board offers its merge action from this same predicate, so the button and
 * the merge precondition cannot drift apart again.
 */
export function isSoleGeniusHumanDecisionHold(pullRequest) {
  const reasons = Array.isArray(pullRequest?.reasons) ? pullRequest.reasons : [];
  const cards = pullRequest?.geniusGuidance?.cards;
  return pullRequest?.status === "open"
    && pullRequest?.checkStatus === "action_required"
    && pullRequest?.reviewer === "genius"
    && pullRequest?.draft !== true
    && reasons.length === 1
    && reasons[0] === GENIUS_HUMAN_DECISION_REASON
    && Array.isArray(cards)
    && cards.length > 0;
}

/**
 * Convert the one expected Genius hold into the Test OK shape required by the
 * merge engine. The caller decides whether the merge is the board's explicit
 * human action; automatic merge never applies it.
 */
export function approvedPullRequestForManualMerge(pullRequest) {
  return isSoleGeniusHumanDecisionHold(pullRequest)
    ? { ...pullRequest, checkStatus: "test_ok", reasons: [] }
    : pullRequest;
}
