# Revisor

Revisor is LUDIARS' public, independent local pull-request review service.
It accepts authenticated requests from GitHub Actions, queues exact PR heads,
and processes them with a bounded child-process worker pool.

Revisor combines:

- an opposite-provider code review and autofix pass;
- temporary Anatomia PR-diff analysis;
- target-domain and spec traceability checks;
- changed orphan-function and architecture-gate checks;
- complexity-score regression detection;
- high-confidence information-leakage detection on added diff lines;
- optional original-session context from Concordia.

## Independence

Revisor has no runtime dependency on Castra, the Concordia process, or the
Anatomia web service.

- Castra only provisions Cloudflare and GitHub Actions secrets.
- When Concordia is running, Revisor reads session context over its HTTP API.
- When Concordia is stopped, Revisor opens `Concordia/concordia.db` read-only.
- Revisor invokes `bin/anatomia.mjs` from a configured existing Anatomia
  checkout. If a repository has no persistent Anatomia project yet, it
  registers and analyzes it before the temporary PR comparison.

The review worker never executes PR repository code. Build, test, and lint
run on the GitHub-hosted runner before it submits the review request.

Before any PR diff is sent to an opposite-provider reviewer, Revisor scans
added lines for private keys, known provider tokens, webhooks, embedded
credentials, and sensitive credential files. A high-confidence finding blocks
external review and reports only its rule, path, and line; the matched value is
never copied into job state, Check Run output, or errors. Autofix results and
verification-only runs are scanned again. An unsafe autofix is discarded before
Revisor commits or pushes it.

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

`serve` resolves its port from the Excubitor service code `revisor`; the port
is not configured inside this repository.

## Settings UI

The loopback root page configures:

- the existing Anatomia folder;
- fallback reviewer (`Codex Sol` or `Claude Opus`);
- one through eight child worker processes;
- optional Concordia context lookup;
- the encrypted PR-gate origin token.
- the GitHub App ID and encrypted private key used to publish Check Runs.

The worker count controls both child-process count and queue concurrency.
Changes to the worker count apply on the next service start.

Configuration defaults to:

- Windows: `%LOCALAPPDATA%\LUDIARS\revisor.config.json`
- Other platforms: `~/.config/ludiars/revisor.config.json`

The adjacent `revisor.config.key` encrypts the origin token with AES-256-GCM.
The paths can be overridden with `REVISOR_CONFIG_PATH` and
`REVISOR_KEY_PATH`. `REVISOR_MASTER_KEY` is available for an intentional
external key override.

## External API

Cloudflare Access should expose only `/v1/pr-gate/*`.

```text
POST /v1/pr-gate/jobs
GET  /v1/pr-gate/jobs/:id
```

Requests require the configured origin token as a Bearer token. Fork PRs are
rejected before queueing. The same repository, PR number, and head SHA are
deduplicated. A successful submission creates a queued `Revisor review` Check
Run. Revisor updates it to `in_progress` and finally to `success`,
`action_required`, or `failure`; the GitHub-hosted workflow does not poll.

The request `review_mode` is either `full` or `verification`. Revisor autofix
commits carry the `Revisor-Autofix: true` trailer. CI reruns on those exact
heads submit `verification`, which performs the Anatomia gates without
repeating the opposite-provider review.

## GitHub App

Create and install a GitHub App on every reviewed repository with:

- Repository permissions: `Checks: Read and write`
- No webhook events are required for the enqueue flow

Enter the App ID and generated PEM private key in the loopback settings UI.
The private key is encrypted with the same local master key as the origin
token. Installation access tokens are requested per repository and cached
only until shortly before their one-hour expiry.

## Development

```powershell
npm test
npm run check
```

Revisor uses only Node.js standard-library modules.

## License

[MIT](LICENSE)
