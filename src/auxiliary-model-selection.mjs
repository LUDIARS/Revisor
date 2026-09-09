import { forcedReviewerFor } from "./forced-review-model.mjs";

const REVIEWERS = ["codex-sol", "claude-opus"];

/** @implements SPEC-AUXILIARY-MODEL-CAPACITY */
export function selectAuxiliaryReviewer(activeRequests) {
  const running = new Map(REVIEWERS.map((reviewer) => [reviewer, 0]));
  for (const request of activeRequests) {
    if (request?.stage !== "reviewer") continue;
    const options = request.options ?? {};
    const reviewer = options.purpose === "auxiliary"
      ? options.reviewer
      : forcedReviewerFor(options.forcedModel) ?? options.reviewer;
    if (running.has(reviewer)) running.set(reviewer, running.get(reviewer) + 1);
  }
  // Equal load prefers Terra; the choice is made when a worker becomes free,
  // so queued tasks do not all reserve the same stale snapshot.
  return REVIEWERS.reduce((best, reviewer) =>
    running.get(reviewer) < running.get(best) ? reviewer : best);
}
