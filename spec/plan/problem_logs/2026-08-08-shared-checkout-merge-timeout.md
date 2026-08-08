# Shared Checkout Merge Timeout Regression

- Date: 2026-08-08
- Status: fixed in working tree
- Area: Revisor local PR merge
- Severity: high

## Summary

Local PR merge mutated the registered project checkout before publishing. This is a
recurring regression: a project checkout containing normal user work or generated
files could block every Revisor merge and could have its branch and stash changed by
the service.

## Evidence

- Local PR #324 failed at `2026-08-08T11:09:07.823Z` with
  `git stash failed: ... process timed out` after the merge action.
- Local PR #314 had previously failed with
  `GitHub 'main' moved independently; reconcile it with local 'main' before publishing.`
- `src/checkout-hygiene.mjs::restoreBaseCheckout` ran
  `git status --porcelain --ignored` followed by `git stash push --all` in the
  registered Concordia checkout. Its ignored dependency/build tree made the stash
  exceed the process timeout.

## Regression Context

The checkout-hygiene policy attempted to make an operational checkout safe enough
for publication by stashing debris and switching it back to the base branch. Each
additional repair still depended on mutable shared worktree state, so it could not
provide a stable merge boundary.

## Cause

`LocalPrService` passed the registered repository record directly to
`squashMergeLocalPullRequest`. Merge, base reconciliation, local release state, and
publication therefore all used `repository.rootPath`, the same checkout used by
people, sessions, tests, and generated artifacts.

## Fix Requirements

- Revisor owns one persistent, independent Git clone per registered repository under
  the directory containing `revisor.state.json`.
- A merge reads Git objects for the reviewed head from the registered repository but
  never changes its worktree, index, refs, branch, stash, hooks, or ignored files.
- The clone's base is initialized once. Only Revisor publication and GitHub base
  reconciliation may advance it; later source synchronization refreshes the head only.
- Prepared-merge recovery refs, release version state, tags, reconciliation, and push
  all operate in the isolated clone.
- Every merge failure is emitted as a structured, redacted runtime error. The board
  keeps a bounded redacted summary.

## Verification

- An integration test creates tracked edits, untracked notes, and ignored generated
  content in the source checkout, performs a squash merge in the clone, and compares
  source branch, base ref, status, and stash list before and after.
- A persistence test proves a second preparation preserves the Revisor-owned base and
  refreshes only the source head.
- A logging test proves the runtime record is structured and secret-redacted.

## Follow-up

After deployment, retry local PRs #314 and #324. The old checkout-hygiene module and
its stash-based regression tests are removed rather than retained as a fallback.
