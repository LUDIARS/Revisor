# Architecture

## Purpose

Revisor owns the local PR review queue and review execution lifecycle. It is
separate from the projects it reviews and from the services whose persisted
information it consumes.

## Components

- `server.mjs` owns the HTTP server and authenticated job API.
- `queue.mjs` owns FIFO state, deduplication, and concurrency admission.
- `github-app.mjs` owns GitHub App JWT and installation-token authentication.
- `check-reporter.mjs` owns Check Run lifecycle projection.
- `worker-pool.mjs` owns child-process lifetime and one-job-per-worker dispatch.
- `runner.mjs` orchestrates one admitted review.
- `workspace.mjs` owns disposable Git worktrees and exact-head validation.
- `anatomia.mjs` owns direct CLI analysis.
- `leakage.mjs` owns value-free secret and sensitive-file detection on added
  unified-diff lines.
- `concordia-context.mjs` owns optional live and persisted session context.
- `config.mjs` owns local settings and encrypted origin-token/private-key
  persistence.
- `ui-*.mjs` own the loopback-only settings surface.

The queue concurrency and worker-process count are created from the same
validated setting. A queue can therefore never admit more simultaneous review
runs than the pool has workers.

## Data boundaries

- Job state and PR-diff reports are process-local and temporary.
- Leakage findings contain only rule, path, and line metadata. Suspected values
  are neither persisted nor projected to GitHub.
- Stable Anatomia project data remains owned by Anatomia's configured CLI
  checkout and cache.
- Concordia SQLite access is read-only.
- The origin token is encrypted locally and is never returned by the API.
- The GitHub App private key is encrypted locally and is never returned by the
  API. Expiring installation tokens remain process-local.
- Repository code is checked out only into disposable detached worktrees.

## Failure policy

Missing required configuration fails a review job explicitly. Concordia
context and notification are optional capabilities; losing them is reported
through `contextSource` and does not replace review execution with a stub.
Worker crashes fail their active job and cause the pool to create a replacement
worker. A GitHub authentication or Check Run update failure fails the job
explicitly instead of silently losing the required status. Shutdown rejects
waiting work and terminates every owned child process.

High-confidence leakage findings stop the full review before the diff or
session context reaches an external model. Verification findings complete the
Check Run as `action_required`. Post-autofix findings fail the job and the
disposable worktree is discarded before any commit or push.
