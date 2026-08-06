export const GENIUS_HUMAN_DECISION_REASON =
  "Genius judgment cards require a human decision";

const SYSTEM_REVIEW_REASON_PATTERNS = [
  /^reviewer reported insufficient information /,
  /^the security scan did not complete:/,
  /^the security scan produced no usable result$/,
];

const PRE_MERGE_SYSTEM_FAILURE_PATTERN =
  /pre-merge security scan (?:did not complete|produced no usable result)/i;
const HARD_FAILURE_PATTERN =
  /information leakage|registered test|security finding\(s\)|actual finding/i;
const SYSTEM_FAILURE_PATTERN =
  /Anatomia|reviewer failed|security scan|ENOENT|spawn|timed? out|unavailable|not configured|is not a function|could not (?:start|read|resolve|load)/i;

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
    && reasons.length === 1
    && reasons[0] === GENIUS_HUMAN_DECISION_REASON
    && Array.isArray(cards)
    && cards.length > 0;
}

/**
 * A person may accept a failed review service/environment or a policy-only
 * review hold. Test failures, leakage findings and actual security findings are
 * deliberately absent: human authority is an escape hatch for the machinery,
 * not a way to relabel concrete failing evidence as green.
 */
export function isHumanOverrideableReviewHold(pullRequest) {
  if (isSoleGeniusHumanDecisionHold(pullRequest)) return true;
  if (pullRequest?.status !== "open") return false;
  const reasons = Array.isArray(pullRequest.reasons) ? pullRequest.reasons : [];
  if (pullRequest.checkStatus === "failed") {
    const error = typeof pullRequest.error === "string" ? pullRequest.error.trim() : "";
    return error.length > 0
      && !HARD_FAILURE_PATTERN.test(error)
      && SYSTEM_FAILURE_PATTERN.test(error)
      && reasons.every((reason) =>
        SYSTEM_REVIEW_REASON_PATTERNS.some((pattern) => pattern.test(reason)));
  }
  if (pullRequest.checkStatus !== "action_required") return false;
  return reasons.length > 0
    && reasons.every((reason) => SYSTEM_REVIEW_REASON_PATTERNS.some((pattern) => pattern.test(reason)));
}

export function canBypassPreMergeSystemFailure(pullRequest) {
  return pullRequest?.status === "open"
    && typeof pullRequest?.mergeError === "string"
    && PRE_MERGE_SYSTEM_FAILURE_PATTERN.test(pullRequest.mergeError);
}

/**
 * Convert the one expected Genius hold into the Test OK shape required by the
 * merge engine. The caller decides whether the merge is the board's explicit
 * human action; automatic merge never applies it.
 */
export function approvedPullRequestForManualMerge(pullRequest) {
  return isHumanOverrideableReviewHold(pullRequest)
    ? {
        ...pullRequest,
        checkStatus: "test_ok",
        reasons: [],
        error: null,
        humanQuestion: null,
        // A worker may fail before projecting a reviewed SHA. Explicit human
        // approval pins the current submitted head as the content being accepted.
        reviewedHeadSha: pullRequest.reviewedHeadSha ?? pullRequest.headSha,
      }
    : pullRequest;
}
