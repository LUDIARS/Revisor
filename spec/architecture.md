# Architecture

## Purpose

Revisor owns the local PR, CI, review, merge, and outgoing-main leakage-gate
lifecycle. Hosted pull requests and remote feature branches are outside the
runtime architecture.

## Components

- `server.mjs` owns the loopback-bound HTTP server and the local API. Reads (`GET`)
  are served to loopback without a token; mutations (submit / merge / retry /
  repository registration) still require the workflow token. A uniform token
  requirement meant that a same-machine reader such as Concordia's Test Forum sync
  had to be handed a secret, and the absence of a distribution path for it silently
  disabled the feature. A token-free read covers every `GET` on the local API, so
  its disclosure is the whole read projection, not just names and states: PR
  titles, bodies, authors, branch names and head/base SHAs, the review verdict
  with its reasons and advisories, the leakage and security findings (rule, file
  and line only — matched values are never persisted), and, on
  `GET /v1/repositories`, the absolute working-tree and hook paths. The state file
  behind those reads is `0600`, so opening them to the loopback port widens the
  audience from the owning OS account to every account on the machine; Revisor
  treats the workstation as single-user and accepts that.
  A token-free read requires both a loopback peer address and a loopback
  `Host` header: the peer check alone falls to DNS rebinding, where an attacker
  domain pointed at 127.0.0.1 is same-origin to the browser and reads the body
  without CORS. Reads through a configured non-loopback host, and every mutation,
  still require the workflow token — it stays where it actually matters.
- `local-contracts.mjs` validates repository, test-case, and PR inputs.
- `catalog.mjs` owns managed-service bootstrap location resolution. Excubitor
  injects `REVISOR_PORT` from its aggregated catalog; direct CLI starts fall back
  to the central catalog. See `spec/feature/service-bootstrap.md`.
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
- `process.mjs` owns child-process invocation: captured stdout/stderr, a killing
  timeout, the Windows shim launch for npm-installed CLIs, and the optional
  per-call environment a caller adds a variable to. It belongs to the
  `runtime-execution` domain and carries no caller policy — what a variable means
  is decided by the adapter that adds it (`security-scan.mjs` for the scanner
  state directory).
- `ci.mjs` runs registered argv test cases and retains outcome metadata, plus the
  captured output of the cases that failed. Cases the plan did not select are
  recorded as `skipped` with the reason.
- `test-output.mjs` owns that capture: failures only, leakage-redacted, and
  truncated to a tail whose truncation is stated in the stored text.
- `anatomia.mjs` owns direct CLI analysis.
- `leakage.mjs` detects sensitive additions without retaining matched values.
- `security-scan.mjs` runs the `codex-security` CLI over a committed diff in a
  disposable worktree, retains finding locations only, and deletes the scan
  report artifacts. Each scan gets a private `CODEX_SECURITY_STATE_DIR`, because
  the scanner's default state directory is shared machine-wide and its SQLite
  write lock would serialise the workers.
- `local-merge.mjs` creates a squash commit in a disposable worktree, scans that
  exact squashed diff, and advances the local base branch.
- `push-guard.mjs` installs a repository-scoped hook chain and blocks unsafe
  outgoing `main` updates as `amend_required`.
- `concordia-context.mjs` owns optional live and persisted author context, the
  optional Concordia loopback location, session injection, and shared chat
  publishing.
- `review-completion-notice.mjs` composes the terminal-verdict message and sends
  it to the submitting session, if there is one.
- `pr-lifecycle-notice.mjs` composes bounded PR creation, review-result, and
  merge messages for Concordia's Discord-backed report channel.
- `config.mjs` owns local settings plus encrypted workflow-token and
  allowed-host persistence.
- `host-policy.mjs` normalizes exact hostnames and authorizes loopback or
  encrypted configured hosts.
- `ui-*.mjs` own the workflow surface exposed directly on loopback or through a
  configured local reverse proxy. `ui-styles.mjs` owns the responsive stylesheet,
  `ui-layout.mjs` the shared shell, `ui-pr-view-script.mjs` the client-side card
  and detail rendering, `ui-pr-board-page.mjs` the `/` triage board and its
  controller, `ui-dashboard-page.mjs` the `/dashboard` operational panels, and
  the settings page every configuration form.

Allowed-host registration is an independent settings boundary. Its dedicated
UI-session-protected endpoint does not require the Anatomia folder or workflow
token to be configured, so a loopback operator can authorize the external host
needed to finish setup; the new host takes effect in the same running process.
The general settings endpoint rejects the field rather than dropping it, so a
success response never reports a host registration that did not happen. See
`feature/ui-http-boundary.md`.

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
the submitting Concordia session (optional), a sequential number drawn from one
sequence shared by every registered repository, base/head refs, exact original
SHAs, workflow status, CI outcomes, projected Anatomia data, leakage locations,
the security scan outcome and its finding locations, the review plan, the
merge-risk and runtime-verification assessments, the automatic merge outcome,
and the final reviewed SHA. The test workflow is a derived view containing the
latest non-draft Open PR per repository while it is `queued`, `running`, or
`test_ok`. The first two states are early-QA candidates for the current head;
only `Open / Test OK` means the review gate has passed.

The number is global rather than per-repository because it is used on its own to
identify a pull request across the workflow (`Rv#xxx`), which a number that
repeats in every repository cannot do. A state file written by the earlier
per-repository scheme (`version: 1`) is renumbered on read, ordered by creation
time and broken by id, so the same stored state always yields the same numbers —
a read performs no write, and a non-deterministic migration would renumber the
board on every read.

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
through Concordia, after any automatic merge so the reported state is final.
A non-draft PR appears in the TestWorkflow forum from `queued` onward, for as
long as it is its repository's latest candidate, so a person may start QA before
review settles. The terminal notice points to that forum thread when the PR is
left at `Open / Test OK`; an automatically merged one reports the merge instead,
and a draft is told to leave draft rather than sent to a thread it never gets.

Resubmitting the same head joins the review already running for it, so a
submission that names a session adopts it as the notice target when the review
it joined has none; an existing target is never replaced, because one review
sends one notice.

A review a restart could not resume is a failed run too, so startup recovery
announces the pull requests it had to fail; otherwise the session that submitted
one would wait on a review no worker will ever own.

The notice is best-effort: a submission without a session, an unreachable
Concordia, or a failed send never changes the verdict, fails the job, or blocks
startup. The review runner emits no interim Concordia message; the reporter is
the sole owner of the terminal completion notice after the final state exists.

## Discord PR lifecycle notice

Every session-bound local PR lifecycle transition that changes what an operator
needs to know is also published to Concordia's shared `報告` chat channel: PR
creation, review pass or failure, and merge. Revisor propagates the submitting
Concordia session ID because Discord egress rejects unbound chat rows; CLI and
script submissions without a session stay silent instead of claiming a Discord
delivery that cannot occur. Concordia owns Discord credentials and delivers that
channel to the Discord `houkoku` surface, so Revisor never stores a Discord token
or webhook URL. Review completion and merge remain separate events, including
when automatic merge follows a passing review immediately.

Lifecycle messages contain only PR metadata and bounded failure reasons. They do
not include diffs, test output, leakage values, or credentials. Titles, branch
names, and failure reasons are author-controlled, so they are flattened to a
single line and their `@everyone` / `@here` / `<@id>` mention syntax is
neutralized before it reaches a Discord-backed channel. Delivery is best-effort:
a missing Excubitor catalog entry, unavailable Concordia, disabled Discord
egress, or rejected post never changes PR admission, review, or merge. A single
transition never produces two notices: an unresumable interrupted review is
announced once, by the recovery pass, with its final reason.

See `spec/feature/pr-lifecycle-notice.md` for the `pr-notification` domain.

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
the domain review, or the spec-requirement check. The review strategy is also
deterministic: a change that touches `spec/` receives the opposite-provider
autofix, while every other change receives public Genius judgment cards and is
held for a human decision. Genius is resolved from the Excubitor catalog and a
missing or invalid response fails explicitly rather than silently spending on an
external reviewer. An optional control planner — a daemon-less Augur CLI or a
control model — may adjust only the `spec_autofix` plan inside a safety floor it
cannot cross. `spec/feature/review-plan.md` is authoritative.

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

A pull request that will never merge is closed instead of being left open: the
status moves `open → merged` or `open → closed`, never back, and a terminal pull
request refuses merge, retry, and a second close. Closing is refused while a
review is in flight, because the running worker writes its own result back last.
`spec/feature/pr-lifecycle.md` is authoritative.

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

Every disposable worktree is removed on normal and exceptional paths. Deleting
the temporary directory that held them is best-effort: a filesystem that keeps
the directory locked leaves a harmless out-of-Git copy behind rather than failing
an otherwise complete review. `spec/feature/local-workspace.md` is authoritative.
Unsafe reviewer changes are discarded before commit or local branch advancement.

The queue is in-memory while check status is persisted, so a process that dies
mid-review leaves `queued` / `running` state no worker owns. Startup therefore
re-queues every open PR still in those states, since an empty queue makes the
classification unambiguous and no time threshold is needed. Each PR is recovered
independently: one that can no longer be resumed is failed with the reason
instead of being left unowned, and recovery runs after the port is listening so
slow ref resolution does not delay it.
