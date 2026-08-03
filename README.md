# Revisor

Revisor is the local control plane for **LUDIARS LOCAL PR WORKFLOW**. Feature
branches stay on the workstation: Revisor records GitHub-compatible pull
request metadata, runs registered CI and Anatomia analysis, performs an
opposite-provider review, and squash merges approved changes into local
`main`.

Only `main` is eligible for a later remote push. A managed pre-push hook scans
the outgoing `main` diff for high-confidence leakage. Unsafe pushes are
blocked as `amend_required`; after the local commit is amended, the next push
is scanned again. Any feature-branch create or update is rejected before data
leaves the workstation.

## Workflow

1. Register a local repository, its base branch, and at least one test case.
   Revisor installs a repository-scoped pre-push guard without replacing
   existing shared hooks.
2. Create a local PR from an existing, clean local branch. Revisor records
   title, body, author, base/head refs, and exact SHAs. It never fetches or
   pushes the feature branch.
3. Revisor plans the review from the change profile of the submitted diff: a
   documentation edit skips the Anatomia code analysis and the Codex Security
   scan and runs only the test cases that cover documentation, while the leakage
   scan, the Anatomia domain review, the spec-requirement check and the
   opposite-provider review always run.
4. A disposable detached worktree runs the planned tests, the leakage scan, the
   temporary Anatomia PR analysis, and — when the plan asked for it and neither
   the leakage scan nor the tests already block — one Codex Security scan of the
   committed PR diff.
5. If the first scan and CI pass, the opposite-provider reviewer may apply
   scoped fixes. Revisor scans and tests the result again before advancing the
   local head branch.
6. Revisor scores the merge risk and whether a human still has to run the
   product, both itemised.
7. The UI leads with the pull requests that need a human decision. Only passing
   open PRs appear in the test workflow as `Open / Test OK`.
8. A pull request at or below the risk threshold the operator accepted merges
   automatically; everything else waits for a person. Revisor creates one squash
   commit, runs the final Codex Security scan against the exact squashed diff,
   and fast-forwards the local base branch. It does not push.

A merge is attempted when the review completes and again on a sweep every 60
seconds, because a pull request that was not mergeable at the moment its review
finished would otherwise sit at `Open / Test OK` forever. The base branch is not
pinned to the SHA it had at review time — every merge advances it, so pinning
would make each merge block all the remaining ones. What is checked instead is
that the squash still applies (a conflict drops the PR to `action_required` for
a rebase, since another review will not resolve it) and that the head's diff
content is unchanged since the review (compared by `git patch-id`, so a pure
rebase keeps its review; changed content is re-queued for review automatically).
Merges run one at a time regardless of what triggered them.

For local PRs submitted by a Concordia session, creation, review pass/failure,
and merge are published best-effort through Concordia's `報告` channel to
Discord. Revisor reuses the submitting session binding; sessionless CLI/script
submissions stay local. Concordia owns the Discord credentials, so Revisor only
resolves Concordia from the Excubitor catalog and never stores a Discord webhook
or token.

The Codex Security scan runs at most once per review pass and once right before
the squash merge. It never re-runs after the opposite-provider autofix; the
pre-merge scan covers those edits. Findings at or above the configured severity
block, and an incomplete or failed scan also blocks instead of reading as a
pass. A scan the review plan did not ask for is recorded as skipped with its
reason, which is an advisory and never a pass. Scan report artifacts are deleted
after each run.

Matched leakage values and test output are not stored. Findings contain only a
rule, file path, and line number; Codex Security findings additionally keep
their severity, but never source excerpts or reproduction steps.

## Requirements

- Node.js 22.5 or newer
- Git
- authenticated `codex` and `claude` CLIs
- the `codex-security` CLI (`npm install -g @openai/codex-security`) signed in
  to a ChatGPT/Codex subscription, unless the security scan is disabled in the
  settings. Revisor pins the scan to `--auth chatgpt`, so an `OPENAI_API_KEY` or
  `CODEX_API_KEY` in the environment never silently switches it to metered API
  billing — and never substitutes for the sign-in. Each scan runs against a
  private, throwaway `CODEX_SECURITY_STATE_DIR`, so parallel reviews do not
  queue behind the scanner's machine-wide state database (scan history and
  resume are given up; Revisor deletes the report artifacts anyway).
- an existing Anatomia checkout
- an Excubitor catalog registration when using `revisor serve`

## Commands

```text
revisor serve
revisor config path
```

`guard-push` is an internal command used only by Revisor-managed Git hooks.

## Pages

`/` is the pull request board and holds nothing else, so the whole first screen
is the set of changes waiting on someone. Open local pull requests are cards
ordered by who has to act next: the ones needing a human decision, then
failures, then reviews in flight, then the ones clear to merge. Each card
carries the decision badge, the merge-risk score against the configured
threshold, whether a human still has to run the product, the test summary
including skipped cases, and the reasons it is waiting. A filter shows only the
ones needing a decision. The layout is responsive: on a wide screen the list
sits beside the detail of the selected pull request, and below 960px the two
panes stack, so on a phone the cards run full width with touch-sized controls
and a decision can be made without a desktop.

`/dashboard` holds the operational view: registered repositories, local PR
creation, the test workflow, and the review queue.

Selecting a pull request opens its detail: the decision with the itemised risk
and runtime-verification factors, the review plan with each stage and why it ran
or did not, registered test outcomes, review state (reviewer, blocking reasons,
advisories, leakage findings, open question), and the Anatomia diff analysis. A
failed review can be re-queued against the branch heads as they stand at that
moment.

Advisories are reported without blocking a merge: a failed warn-severity Anatomia
gate (`spec_linkage`, `coupling_delta`, `convention_drift`), changed orphaned
functions, non-error architecture violations, and test cases the review plan did
not require. Everything else — failed tests, leakage findings, error-severity
violations, a material complexity drop, a missing target domain, a
block-severity Anatomia gate (`rule_conformance`, `duplication`) or any gate
outside that advisory set — still blocks. When the deterministic plan drops code
analysis, its gates and violations become advisories too, because nobody asked
for that evidence on that change; a skip a control planner asked for does not
relax the gate.

`/settings` holds every configuration form, including project registration.

## Settings and state

The loopback UI configures:

- the existing Anatomia folder;
- fallback reviewer (`Codex Sol` or `Claude Opus`);
- the Codex Security scan: enabled or not, the blocking severity threshold
  (`critical`/`high`/`medium`/`low`, default `high`), and a per-scan USD cost
  cap;
- one through eight worker processes;
- optional Concordia context;
- who decides the review plan: the deterministic rules alone, a daemon-less
  Augur CLI, or a control model. A missing or failing planner falls back to the
  deterministic plan, and an external model is never asked while a leakage match
  is outstanding;
- whether to merge automatically, the merge-risk score accepted for it (0–100),
  and whether a required human run blocks it. Automatic merging is off until the
  accepted risk is stated;
- an encrypted local workflow API token.
- encrypted allowed hostnames for Cloudflare Tunnel or another local reverse
  proxy. Loopback hostnames remain permanently allowed.

A test case may declare which change kinds it covers (`kinds`), that it always
runs (`always`), and that it is a runtime check (`runtime`). A case that declares
nothing covers executable change only, so existing registrations behave exactly
as before on code and stop running on documentation-only changes.

Moving the accepted risk threshold takes effect on the next read: the board
re-colours, re-orders, and re-qualifies without re-reviewing anything.

Configure a new external hostname from `http://127.0.0.1:<port>/` first. Host
entries are exact, case-insensitive hostname matches; schemes and paths are not
accepted. Changes apply to new requests immediately without restarting Revisor.

Repository registrations, local PR status, CI outcome metadata, Anatomia
projections, and push-guard status are stored in `revisor.state.json` beside
the configuration. Override the location with `REVISOR_STATE_PATH`.

Configuration defaults to:

- Windows: `%LOCALAPPDATA%\LUDIARS\revisor.config.json`
- Other platforms: `~/.config/ludiars/revisor.config.json`

`REVISOR_CONFIG_PATH`, `REVISOR_KEY_PATH`, and `REVISOR_MASTER_KEY` remain
available for intentional overrides.

## Local API

The API listens on loopback. Mutations require the workflow token; reads are
served without one as long as the request arrives from a loopback address *and*
carries a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`), so a same-machine
reader needs no secret while a rebound attacker domain still does:

```text
POST /v1/repositories        workflow token
GET  /v1/repositories        loopback only
POST /v1/local-prs           workflow token
GET  /v1/local-prs           loopback only
GET  /v1/local-prs/:id       loopback only
POST /v1/local-prs/:id/merge workflow token
POST /v1/local-prs/:id/retry workflow token
POST /v1/local-prs/:id/close workflow token
GET  /v1/test-workflow       loopback only
```

`close` はマージせずに PR を終局させる (別経路で main へ入った / 案を破棄した)。
任意の `{"reason": "..."}` を記録し、board・test workflow・オートマージの対象から
外す。終局済み (`merged` / `closed`) の PR は merge も retry も close も拒否する。
審査中 (`queued` / `running`) の close も拒否する — 走っているワーカーが完了時に
自分の結果を書き戻すので、先に閉じても上書きされて open へ戻ったように見えるだけ。
squash マージの実行中も同じ理由で拒否する。こちらは完了した merge が `merged` を
書き戻すため、取り下げたはずの変更がそのまま main へ入ってしまう。

A read through a configured external hostname still requires the workflow token.
Opening the reads widens their audience from the owning OS account to every
account on the machine; Revisor treats the workstation as single-user.

Repository registration includes test cases as argv, never a shell string:

```json
{
  "repository": "LUDIARS/Revisor",
  "root_path": "E:/Document/Ars/Revisor",
  "base_ref": "main",
  "test_cases": [
    { "name": "unit", "command": "npm", "args": ["test"], "cwd": "." },
    { "name": "check", "command": "npm", "args": ["run", "check"], "cwd": "." }
  ]
}
```

A local PR contains the same author-facing metadata as a hosted PR, while SHAs
are resolved by Revisor from local refs:

```json
{
  "repository": "LUDIARS/Revisor",
  "title": "Add local workflow",
  "body": "Feature branch remains local.",
  "author": "neco",
  "draft": false,
  "labels": ["workflow"],
  "assignees": ["neco"],
  "reviewers": ["revisor"],
  "head_ref": "feat/local-workflow"
}
```

## Development

```powershell
npm test
npm run check
```

Revisor uses only Node.js standard-library modules.

## License

[MIT](LICENSE)
