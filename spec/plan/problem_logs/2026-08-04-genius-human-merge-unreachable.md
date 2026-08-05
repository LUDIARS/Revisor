# Genius human-decision merge was unreachable

- Date: 2026-08-04
- Status: fixed in working tree
- Area: local PR human-decision lifecycle
- Severity: blocks every Genius-tier PR from merging

## Summary

This is a workflow regression. The PR board displayed `Genius を確認して squash merge` for a
Genius-reviewed `action_required` PR, but invoking that action always failed. Anatomia local PR
#197 could therefore neither auto-merge nor complete its required human approval.

## Evidence

- User-visible failure on 2026-08-04: `Only an Open / Test OK local PR can be squash merged.`
- `src/ui-pr-board-page.mjs` exposes the merge action when reviewer is `genius` and status is
  `action_required`.
- `src/local-pr-service.mjs` forwarded that unchanged record to `src/local-merge.mjs`, whose
  entry contract accepts only `checkStatus === "test_ok"`.

## Regression Context

Genius-tier review intentionally remains `action_required` to prevent automatic merge and require
a person to inspect public judgment cards. The UI was added for that policy, but the service path
did not translate the acknowledged hold into the merge engine's approved shape.

## Cause

The UI eligibility policy and merge-service precondition disagreed. No service-level regression
test exercised a Genius card hold through the explicit manual merge action.

## Fix Requirements

- Accept only an open Genius review whose sole blocker is the known human-decision reason.
- Require at least one stored public Genius judgment card.
- Keep all additional blockers fail-closed.
- Do not make Genius reviews eligible for automatic merge.
- Preserve normal pre-merge stale-head, security, publication, and lifecycle checks.
- Derive the board's merge action from the same predicate as the merge precondition, so the two
  policies cannot disagree again.

## Verification

Add service tests for the accepted sole-card hold and for rejection when another blocker remains.
Do not run tests in this session unless explicitly requested; submit them to Revisor's registered
test workflow.

## Follow-up

After Revisor merges and restarts this fix, retry the explicit Genius-confirmed merge for Anatomia
local PR #197.
