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
3. A disposable detached worktree runs every registered test, leakage scan,
   and temporary Anatomia PR analysis.
4. If the first scan and CI pass, the opposite-provider reviewer may apply
   scoped fixes. Revisor scans and tests the result again before advancing the
   local head branch.
5. The UI exposes PR state, per-test outcomes, Anatomia data and complexity
   score delta. Only passing open PRs appear in the test workflow as
   `Open / Test OK`.
6. Revisor creates one squash commit and fast-forwards the local base branch.
   It does not push.

Matched leakage values and test output are not stored. Findings contain only a
rule, file path, and line number.

## Requirements

- Node.js 22.5 or newer
- Git
- authenticated `codex` and `claude` CLIs
- an existing Anatomia checkout
- an Excubitor catalog registration when using `revisor serve`

## Commands

```text
revisor serve
revisor config path
```

`guard-push` is an internal command used only by Revisor-managed Git hooks.

## Settings and state

The loopback UI configures:

- the existing Anatomia folder;
- fallback reviewer (`Codex Sol` or `Claude Opus`);
- one through eight worker processes;
- optional Concordia context;
- an encrypted local workflow API token.
- encrypted allowed hostnames for Cloudflare Tunnel or another local reverse
  proxy. Loopback hostnames remain permanently allowed.

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

The API listens on loopback and requires the workflow token:

```text
POST /v1/repositories
GET  /v1/repositories
POST /v1/local-prs
GET  /v1/local-prs
GET  /v1/local-prs/:id
POST /v1/local-prs/:id/merge
GET  /v1/test-workflow
```

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
