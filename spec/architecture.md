# Architecture

## Purpose

Revisor owns the local PR, CI, review, merge, and outgoing-main leakage-gate
lifecycle. Hosted pull requests and remote feature branches are outside the
runtime architecture.

## Components

- `server.mjs` owns the loopback-bound HTTP server and authenticated local API.
- `local-contracts.mjs` validates repository, test-case, and PR inputs.
- `state-store.mjs` atomically persists repository and local PR projections.
- `local-pr-service.mjs` orchestrates registration, submission, re-review, and
  merge.
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
- `config.mjs` owns local settings plus encrypted workflow-token and
  allowed-host persistence.
- `host-policy.mjs` normalizes exact hostnames and authorizes loopback or
  encrypted configured hosts.
- `ui-*.mjs` own the workflow surface exposed directly on loopback or through a
  configured local reverse proxy. `ui-layout.mjs` owns the shared shell, the
  dashboard page owns open PRs and their review detail, and the settings page
  owns every configuration form.

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

Re-reviewing an open local PR re-resolves both refs, discards the previous
run's outcome, and admits a new run even when neither ref moved.

## Data boundaries

- Feature branches, diffs, and matched leakage values are never sent to GitHub.
- Test stdout/stderr is process-local and is not persisted.
- Leakage findings contain only rule, path, and line metadata.
- Reviewer access is blocked before external-model invocation when the local
  leakage scan finds a high-confidence match.
- Repository code is inspected only at fixed local SHAs in disposable detached
  worktrees.
- The workflow token and configured external hostnames are encrypted locally;
  the token is never returned by the API.

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

## Merge gate policy

A local PR blocks on registered test failures, information leakage findings,
error-severity changed architecture violations, a material complexity-score
drop, a missing target domain, an Anatomia gate other than `spec_linkage`, and
a reviewer that reports `PR_GATE_NEEDS_HUMAN`.

A change that touches documentation files only is exempt from the target-domain
requirement: documentation is itself the domain of such a change, so a missing
code target domain is recorded as an advisory instead. The exemption covers the
gate, the reviewer prompt, and the human question together, so a docs-only
change is never asked to invent a code domain and never blocks on the resulting
`PR_GATE_NEEDS_HUMAN`. The final gate re-derives the exemption from the reviewed
diff, so an autofix that reaches code files makes the change no longer docs-only
and the missing target domain blocks again. It relaxes nothing else: tests,
leakage, architecture violations, complexity, and every other gate apply
unchanged.

Spec traceability is reported, not enforced: a failed `spec_linkage` gate,
changed orphaned functions, and non-error architecture violations are recorded
as advisories and shown per PR. They do not block a merge, because most
repositories carry no complete Anatomia spec linkage and blocking on it would
stop every PR without protecting what this workflow exists for — keeping
feature branches off the remote and catching information leakage.

An Anatomia verification that fails while naming no gate blocks the merge; it is
never treated as a pass.

## Failure policy

Missing configuration, missing test cases, submitted worktrees carrying tracked
modifications, changed SHAs, failed tests, and blocking Anatomia gates fail
explicitly. Worktree cleanliness considers tracked changes only: untracked files
enter neither a review, which reads a fixed SHA in a disposable worktree, nor a
fast-forward, which Git aborts rather than overwriting them. A submodule's own
uncommitted content is likewise ignored because the parent still records the
same commit; a moved submodule pointer is a tracked change and still blocks.
Worker crashes fail their active job and cause pool replacement. Shutdown
rejects waiting work and terminates owned processes.

Every disposable worktree is removed on normal and exceptional paths. Unsafe
reviewer changes are discarded before commit or local branch advancement.
