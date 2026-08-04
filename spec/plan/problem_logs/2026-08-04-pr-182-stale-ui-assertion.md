# PR #182 retained a stale dashboard assertion

- Date: 2026-08-04
- Status: fixed in working tree
- Area: early QA dashboard coverage
- Severity: registered unit test blocked review

## Summary

Revisor local PR #182 intentionally replaced the dashboard's static
`Open / Test OK` explanation with early-QA wording, but an older UI test still
required the removed literal. This was a regression in test maintenance: the
new behavior and its new test were correct, while the obsolete assertion
blocked the registered unit suite.

## Evidence

At `2026-08-03T23:06:47.379Z`, the `unit` registered test failed after
337860 ms at `test/ui.test.mjs:158`:

`expected: /Open \/ Test OK/`

The `check` registered test passed. The generated dashboard contained the new
text `審査中は先行QA、審査通過後は確定QA`.

## Regression Context

The same PR already added a focused UI test for the early-QA explanation and
state-store coverage for both `Open / In Review` and `Open / Test OK` values.

## Cause

The broad operational-panels test kept an assertion about the old explanatory
copy after that copy moved to the early-QA model.

## Fix Requirements

- Remove the obsolete static-copy assertion from the operational-panels test.
- Keep the focused early-QA copy test and state-store status tests.
- Rebase the branch onto the current local `main` before retrying review.

## Verification

No tests were run in this session per the session policy. Revisor's registered
unit and check cases must verify the updated branch during retry.

## Follow-up

Keep PR #182 open until the retried review reaches a terminal result.
