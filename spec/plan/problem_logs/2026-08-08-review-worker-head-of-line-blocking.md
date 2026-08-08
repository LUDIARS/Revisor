# Review Worker Head-of-Line Blocking

- Date: 2026-08-08
- Status: fixed
- Area: Revisor review queue and worker execution
- Severity: high

## Summary

This is a regression in review throughput. Revisor assigns every review stage to one
all-in-one worker job, so a long-running model review blocks later work even when
other review stages could make progress on available workers.

## Evidence

- neco reported that a Vultus review had been running for about 30 minutes while
  later reviews accumulated behind it.
- `src/server.mjs` dispatches one `createPrReviewRunner` invocation per queue job.
- `src/runner.mjs` runs registered tests, Anatomia analysis, model review, and
  security scanning inside that invocation.

## Regression Context

The worker-count setting permits several complete review jobs, but it does not
describe which expensive stage is running and cannot prioritize a ready model
review over lower-priority diagnostic work.

## Cause

The review queue's unit of scheduling is an entire PR rather than an independently
executable review stage. A worker remains reserved across unrelated waits and work,
creating head-of-line blocking and no operator-visible stage queue.

## Fix Requirements

- Give Anatomia, registered tests, model review/autofix, and security diagnosis
  separate worker queues with PR and stage identity.
- Within each queue, prioritize model review and autofix calls ahead of lower-priority
  diagnostic work that is ready at the same time.
- Preserve the existing review gate semantics and worktree ownership.
- Expose queued and running stage work, worker capacity, and PR identity in the WebUI.
- Emit live invalidations when worker work changes state.
- Make the cost/quality/speed validation skips for Review, Genius, and Anatomia
  domain review independently configurable from the WebUI.

## Verification

- Add deterministic worker-pool tests for priority dispatch and queue-state projection.
- Add server/UI tests for the read-only review-work endpoint and queue panel.
- Revisor registered checks must pass before merge.

## Follow-up

Observe a long-running Vultus review with later PRs queued: ready high-priority
review stages must run on another idle worker instead of waiting for its completion.

## Resolution

- A PR lifecycle job now delegates each expensive stage to its dedicated worker
  pool, with per-stage queue state exposed from `/v1/review-work` and the PR
  board.
- The lifecycle queue no longer limits stage admission. Git worktree metadata
  mutation is instead serialized per source repository, preserving safe setup
  and cleanup while idle stage workers remain usable.
- The three validation skips are stored and applied independently.
