# Architecture

## Purpose

Revisor owns the local PR, CI, review, merge, and outgoing-main leakage-gate
lifecycle. Hosted pull requests and remote feature branches are outside the
runtime architecture.

## Components

- `server.mjs` owns the loopback-bound HTTP server and authenticated local API.
- `local-contracts.mjs` validates repository, test-case, and PR inputs.
- `state-store.mjs` atomically persists repository and local PR projections.
- `local-pr-service.mjs` orchestrates registration, submission, re-review,
  startup recovery of interrupted reviews, and merge.
- `queue.mjs` owns FIFO state, deduplication, and concurrency admission.
- `local-reporter.mjs` projects queue and review results into local PR state.
- `worker-pool.mjs` owns child-process lifetime and one-job-per-worker dispatch.
- `runner.mjs` orchestrates one admitted review.
- `workspace.mjs` owns local-ref validation, disposable worktrees, and
  compare-and-swap branch advancement. It does not fetch or push.
- `change-classification.mjs` derives the change profile — per-path kind, runtime
  surfaces, and diff size — from the changed paths and the unified diff.
- `review-diff.mjs` reads the unified diff and the changed paths out of a
  worktree and turns them into that profile.
- `review-plan.mjs` decides which stages and which registered test cases one
  change needs, and enforces the safety floor an advised plan cannot cross.
- `plan-advisor.mjs` optionally asks a daemon-less Augur CLI or a control model
  for a plan and always fails soft back to the deterministic one.
- `merge-risk.mjs` scores the runtime-verification requirement and the merge
  risk, itemised.
- `pr-disposition.mjs` derives, at read time, whether a pull request needs a
  human and how the board is ordered.
- `auto-merge.mjs` decides whether a reviewed pull request is below the risk the
  operator accepted.
- `ci.mjs` runs registered argv test cases and retains outcome metadata, plus the
  captured output of the cases that failed. Cases the plan did not select are
  recorded as `skipped` with the reason.
- `test-output.mjs` owns that capture: failures only, leakage-redacted, and
  truncated to a tail whose truncation is stated in the stored text.
- `anatomia.mjs` owns direct CLI analysis.
- `leakage.mjs` detects sensitive additions without retaining matched values.
- `security-scan.mjs` runs the `codex-security` CLI over a committed diff in a
  disposable worktree, retains finding locations only, and deletes the scan
  report artifacts.
- `local-merge.mjs` creates a squash commit in a disposable worktree, scans that
  exact squashed diff, and advances the local base branch.
- `push-guard.mjs` installs a repository-scoped hook chain and blocks unsafe
  outgoing `main` updates as `amend_required`.
- `concordia-context.mjs` owns optional live and persisted author context, the
  optional Concordia loopback location, and session injection.
- `review-completion-notice.mjs` composes the terminal-verdict message and sends
  it to the submitting session, if there is one.
- `config.mjs` owns local settings plus encrypted workflow-token and
  allowed-host persistence.
- `host-policy.mjs` normalizes exact hostnames and authorizes loopback or
  encrypted configured hosts.
- `ui-*.mjs` own the workflow surface exposed directly on loopback or through a
  configured local reverse proxy. `ui-styles.mjs` owns the responsive stylesheet,
  `ui-layout.mjs` the shared shell, `ui-pr-view-script.mjs` the client-side card
  and detail rendering, the dashboard page the board and its controller, and the
  settings page every configuration form.

The queue concurrency and worker-process count use the same validated setting,
so the queue never admits more runs than the pool can execute.

## State model

A repository registration contains its local root, base ref, test cases, and
managed hook path. At least one test case is required.

A repository test case may additionally declare the change kinds it covers
(`kinds`), that it always runs (`always`), and that it constitutes a runtime
check (`runtime`). All three are optional; a case that declares nothing covers
executable change only.

A local PR records title, body, author, draft, labels, assignees, reviewers,
the submitting Concordia session (optional), sequential repository-local number,
base/head refs, exact original SHAs, workflow status, CI outcomes, projected
Anatomia data, leakage locations, the security scan outcome and its finding
locations, the review plan, the merge-risk and runtime-verification assessments,
the automatic merge outcome, and the final reviewed SHA. The test workflow is a
derived view containing only PRs in `Open / Test OK`.

Whether a pull request needs a human is not stored. It is derived on every read
from the stored assessments and the current settings, so moving the accepted
risk threshold re-colours, re-orders, and re-qualifies the board immediately
without re-reviewing anything.

Re-reviewing an open local PR re-resolves both refs, discards the previous
run's outcome, and admits a new run even when neither ref moved.

## Review completion notice

Reviews run locally and take minutes, so a submitter that had to poll would
either burn a session waiting or walk away and miss the verdict. A submission may
name the Concordia session that made it, and every terminal outcome — merged,
merge-ready, blocked, or a failed run — sends that session exactly one message
through Concordia, after any automatic merge so the reported state is final. Only
a non-draft PR left at `Open / Test OK` appears in the TestWorkflow forum, so its
notice points there for the runtime verification record; an automatically merged
one reports the merge instead, and a draft is told to leave draft rather than
sent to a thread it never gets.

Resubmitting the same head joins the review already running for it, so a
submission that names a session adopts it as the notice target when the review
it joined has none; an existing target is never replaced, because one review
sends one notice.

A review a restart could not resume is a failed run too, so startup recovery
announces the pull requests it had to fail; otherwise the session that submitted
one would wait on a review no worker will ever own.

The notice is best-effort: a submission without a session, an unreachable
Concordia, or a failed send never changes the verdict, fails the job, or blocks
startup.

## Data boundaries

- Feature branches, diffs, and matched leakage values are never sent to GitHub.
- Test stdout/stderr is process-local except for a failed case, whose output is
  kept so the board can say why it failed. It is redacted line by line with the
  leakage rules before it is stored and truncated to its last 12 KB, and the
  truncation is stated in the stored text. A passing case keeps no output.
- Leakage findings contain only rule, path, and line metadata. Security findings
  additionally keep their severity, never source excerpts, reproduction steps, or
  scanner stderr. Saved scan reports are deleted on every path.
- Reviewer access is blocked before external-model invocation when the local
  leakage scan finds a high-confidence match. The security scanner is an external
  model too, so the same leakage match also suppresses the scan.
- Repository code is inspected only at fixed local SHAs in disposable detached
  worktrees.
- The workflow token and configured external hostnames are encrypted locally;
  the token is never returned by the API.

## Review plan

Every review decides its own stage plan before any expensive stage runs, from
the change profile of the submitted diff. A change with no executable content
drops the code analysis and the vulnerability pass but never the leakage scan,
the domain review, the spec-requirement check, or the opposite-provider review.
An optional control planner — a daemon-less Augur CLI or a control model — may
adjust the plan inside a safety floor it cannot cross, and any planner failure
leaves the deterministic plan in force. An external-model planner is not invoked
while a high-confidence leakage match is outstanding, the same boundary the
review itself obeys. `spec/feature/review-plan.md` is authoritative.

## Automatic merging

A reviewed pull request carries an itemised merge-risk score and a
runtime-verification judgement. The operator states the risk they accept; a pull
request at or below that threshold, with no blocking reason, no open question,
not a draft, and — unless the operator says otherwise — no outstanding runtime
verification, merges automatically once, and records the outcome either way.
Automatic merging is off by default. `spec/feature/merge-risk.md` is
authoritative.

## Merge and push boundary

Only `Open / Test OK` PRs can merge. Revisor verifies that both base and
reviewed head still match their recorded SHAs, builds one squash commit in a
disposable worktree, scans that commit against the recorded base SHA, then
compare-and-swap advances the local base ref. It never pushes.

Squash is the only merge strategy, and it is the workspace-wide default (neco
2026-07-30): one PR lands as exactly one commit on the base branch, so the base
history stays reviewable and every landed change maps to one reviewed diff.
There is no merge-commit or rebase-merge alternative to choose from; the base ref
only ever fast-forwards onto that one squash commit.

When a PR collides with a base branch that has moved — the recorded base SHA no
longer matches, or the squash refuses to apply — the author rebases the feature
branch onto the current base and requests a fresh review; Revisor never rewrites
the branch itself. A conflict is a signal to re-derive the change against what
actually landed, and re-reviewing after the rebase is what keeps the recorded
verdict describing the bytes that will merge.

The security scan runs once per review pass and once immediately before the base
ref advances; it never runs after the opposite-provider autofix, because the
pre-merge scan already covers those edits. Findings at or above the configured
severity block the merge, and a scan that does not complete blocks it as well
rather than reading as a pass.

The managed pre-push hook inspects only outgoing updates to the registered base
branch and rejects every non-base branch create/update. A main finding blocks
the push and records `amend_required`; the unsafe SHA is not sent. An amended
commit must pass a subsequent hook invocation.
Existing effective hooks are chained and repository-local hook configuration
does not overwrite the shared hook.

## Merge gate policy

A local PR blocks on registered test failures, information leakage findings,
security findings at or above the configured severity, a security scan that did
not complete, error-severity changed architecture violations, a material
complexity-score drop, a missing target domain, a block-severity Anatomia gate
(`rule_conformance`, `duplication`) or any gate outside the advisory set below,
and a reviewer that reports `PR_GATE_NEEDS_HUMAN`.

A security scan skipped because it is disabled in the settings is silent; a scan
skipped because the leakage gate or the registered tests already block is an
advisory, since the blocking reason is already recorded. A scan result the policy
cannot read — any status other than passed, findings, error, or skipped — blocks
as well, so the review gate and the pre-merge check fail closed on the same rule.

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

`coupling_delta` is an advisory for a different reason: Anatomia's ephemeral
pr-review derives the gate's percentile threshold and call graph from the
analysis environment, so the same commit can fail it in the review worktree and
pass it in a clean local worktree. Until that non-determinism is fixed upstream,
an environment-dependent verdict must not block a merge.

The advisory set is exactly Anatomia's warn-severity gates — `spec_linkage`,
`coupling_delta`, and `convention_drift` — so Revisor is never stricter than the
analyser that produced the verdict. `convention_drift` mines naming case style
and shared affixes from sibling code, so a name that reads fine but differs from
its siblings is a suggestion, not a defect. Anatomia does not carry severity in
its gate results, so the alignment is restated by name in `review-gate.mjs` and
has to be revisited whenever a gate is added or its severity changes upstream.

An Anatomia verification that fails while naming no gate blocks the merge; it is
never treated as a pass.

When the review plan drops code analysis there is no baseline, so the complexity
delta is absent and cannot block, and the quality and architecture findings are
recorded as advisories: gating on a check the plan deliberately did not ask for
would block a change on evidence nobody requested. A registered test the plan did
not select is `skipped`, which is an advisory and never a failure.

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

The queue is in-memory while check status is persisted, so a process that dies
mid-review leaves `queued` / `running` state no worker owns. Startup therefore
re-queues every open PR still in those states, since an empty queue makes the
classification unambiguous and no time threshold is needed. Each PR is recovered
independently: one that can no longer be resumed is failed with the reason
instead of being left unowned, and recovery runs after the port is listening so
slow ref resolution does not delay it.
