# PR #179 review aborted after base advanced

- Date: 2026-08-04
- Status: fixed in working tree
- Area: local PR review lifecycle
- Severity: review blocked before verification

## Summary

Revisor local PR #179 did not reach its registered tests because local `main`
advanced after submission. The allowed-hosts change remained unreviewed even
though its task branch was intact.

## Evidence

At `2026-08-03T22:20:15.316Z`, PR #179 entered `failed` with:

`base SHA changed before review (expected 65f9544505e7cf5b667f5639782e409a6cee8935, found 560c208290ed9b60381cf87defb1c3bf01fdb819)`

No registered test result was produced.

## Regression Context

PR #179 supersedes the stale PR #94 and is the active implementation for
saving allowed hosts before initial setup.

## Cause

The review request captured an older base SHA. Revisor correctly refused to
review a diff whose base had moved.

## Fix Requirements

- Rebase `feat/allowed-hosts-independent-save-v2` onto the current local `main`.
- Preserve the independent, UI-session-protected allowed-hosts endpoint.
- Retry the existing local PR so Revisor records the refreshed head and base.

## Verification

No tests were run in this session per the session policy. Revisor's registered
test plan must run during the retried review.

## Follow-up

Keep PR #179 open until the retried review reaches a terminal result.
