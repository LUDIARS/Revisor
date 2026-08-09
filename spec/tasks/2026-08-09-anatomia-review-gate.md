# Anatomia review gate

- [x] Run PR-diff Anatomia analysis before review-plan advice and reviewer execution.
- [x] Return `action_required` with the original violation details when the mechanical gate blocks.
- [x] Record disabled and unavailable outcomes on the local PR; unavailable analysis continues to LLM review.
- [x] Persist only a safe gate summary, without CLI paths, raw errors, or raw analysis artifacts.
- [x] Add the default-on setting and show the gate result on the PR detail view.
- [x] Cover violation, clean, and unavailable gate outcomes.

The gate runs in `runner.mjs` because that is the single full-review path before both
`advisePlan` (which may invoke an LLM) and `runReviewWithCapacityFallback`.
