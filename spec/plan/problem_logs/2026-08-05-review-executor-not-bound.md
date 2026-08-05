# Intent review executor was not bound

- Date: 2026-08-05
- Status: fixed in working tree
- Area: Revisor review runner
- Severity: every normal review failed before producing evidence

## Summary

Revisor local PR #229 reached the normal intent-review step and failed with
`execute is not a function`. No registered test, reviewer output, or review plan
was recorded, so the failure could not describe the submitted WebUI change.

## Cause

`runReviewWithCapacityFallback` accepts review options and an executor function.
The normal final-review call supplied only the options object. Other call sites
(investigation and autofix) passed `runReview`, which made the defect specific
to the ordinary single-review route.

## Fix Requirements

- Bind the configured executor once inside `createPrReviewRunner`.
- Route both investigation and final intent review through that bound function.
- Fail with a precise type error if the low-level helper is called without an
  executor.
- Cover primary and capacity-fallback execution with a focused unit test.
- Classify an internal `is not a function` TypeError as a system failure so the
  documented human override remains reachable during a similar bootstrap fault.

## Verification

Module syntax and generated UI script checks pass locally. Revisor's registered
`unit` and `check` cases will verify the amended PR during retry.
