# Architecture

## Purpose

Revisor owns the local PR, CI, review, merge, and outgoing-main leakage-gate
lifecycle. Hosted pull requests and remote feature branches are outside the
runtime architecture.

## Components

- `server.mjs` owns the loopback HTTP server and authenticated local API.
- `local-contracts.mjs` validates repository, test-case, and PR inputs.
- `state-store.mjs` atomically persists repository and local PR projections.
- `local-pr-service.mjs` orchestrates registration, submission, and merge.
- `queue.mjs` owns FIFO state, deduplication, and concurrency admission.
- `local-reporter.mjs` projects queue and review results into local PR state.
- `worker-pool.mjs` owns child-process lifetime and one-job-per-worker dispatch.
- `runner.mjs` orchestrates one admitted review.
- `workspace.mjs` owns local-ref validation, disposable worktrees, and
  compare-and-swap branch advancement. It does not fetch or push.
- `ci.mjs` runs registered argv test cases and retains outcome metadata only.
- `anatomia.mjs` owns direct CLI analysis.
- `leakage.mjs` detects sensitive additions without retaining matched values.
- `local-merge.mjs` creates a squash commit in a disposable worktree and
  advances the local base branch.
- `push-guard.mjs` installs a repository-scoped hook chain and blocks unsafe
  outgoing `main` updates as `amend_required`.
- `concordia-context.mjs` owns optional live and persisted author context.
- `config.mjs` owns local settings and encrypted workflow-token persistence.
- `ui-*.mjs` own the loopback-only workflow and settings surface.

The queue concurrency and worker-process count use the same validated setting,
so the queue never admits more runs than the pool can execute.

## State model

A repository registration contains its local root, base ref, test cases, and
managed hook path. At least one test case is required.

A local PR records title, body, author, draft, labels, assignees, reviewers,
sequential repository-local number, base/head refs, exact original SHAs,
workflow status, CI outcomes, projected Anatomia data, leakage locations, and
the final reviewed SHA. The test workflow is a derived view containing only
PRs in `Open / Test OK`.

## Data boundaries

- Feature branches, diffs, and matched leakage values are never sent to GitHub.
- Test stdout/stderr is process-local and is not persisted.
- Leakage findings contain only rule, path, and line metadata.
- Reviewer access is blocked before external-model invocation when the local
  leakage scan finds a high-confidence match.
- Repository code is inspected only at fixed local SHAs in disposable detached
  worktrees.
- The workflow token is encrypted locally and never returned by the API.

## Merge and push boundary

Only `Open / Test OK` PRs can merge. Revisor verifies that both base and
reviewed head still match their recorded SHAs, builds one squash commit in a
disposable worktree, then compare-and-swap advances the local base ref. It
never pushes.

The managed pre-push hook inspects only outgoing updates to the registered base
branch and rejects every non-base branch create/update. A main finding blocks
the push and records `amend_required`; the unsafe SHA is not sent. An amended
commit must pass a subsequent hook invocation.
Existing effective hooks are chained and repository-local hook configuration
does not overwrite the shared hook.

## Failure policy

Missing configuration, missing test cases, dirty submitted worktrees, changed
SHAs, failed tests, and failed Anatomia gates fail explicitly. Worker crashes
fail their active job and cause pool replacement. Shutdown rejects waiting work
and terminates owned processes.

Every disposable worktree is removed on normal and exceptional paths. Unsafe
reviewer changes are discarded before commit or local branch advancement.
