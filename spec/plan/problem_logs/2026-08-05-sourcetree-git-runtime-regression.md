# SourceTree Git runtime broke registered review tests

- Date: 2026-08-05
- Status: fixed in working tree
- Area: runtime execution / registered tests
- Severity: high — valid local PRs could not complete review

## Summary

Revisor resolved `git` from the service `PATH`. On this Windows host that selected
SourceTree's embedded Git 2.24.1. Its executable and shell helper files were not a
coherent distribution, so a registered `git submodule update --init --recursive`
case failed before the repository's own tests ran. The test-autofix model was then
invoked for an infrastructure failure and its output was withheld.

## Evidence

The selected executable was:

```text
C:\Users\raury\AppData\Local\Atlassian\SourceTree\git_local\bin\git.exe
```

`git submodule` could not source `git-sh-setup`; subsequent helper execution also
reported incompatible subcommands. Anatomia local PR #230 surfaced the incident
as `Test autofix model failed` even though its repository tests passed after the
submodules were initialized with one complete Git for Windows distribution.

## Cause

Two process paths delegated Git selection to `PATH`:

- Revisor's workspace and publisher adapters called `runProcess({ command: "git" })`.
- Windows registered tests were wrapped in `cmd.exe`, which resolved a configured
  `git` command independently of Revisor's process boundary.

This made review behavior depend on whichever desktop application last modified
the service environment.

## Fix requirements

- Install one complete Git for Windows distribution under Revisor-owned local
  application state.
- Resolve every internal Git invocation through that runtime and fail closed when
  it is missing or incomplete.
- Reject SourceTree's runtime even if it is supplied as an override.
- Keep registered `git` cases out of the generic Windows `cmd.exe` shim so they use
  the same managed boundary.
- Preserve argv separation and caller-provided authentication environment values.

## Verification

- Resolver tests cover the managed Windows wrapper, SourceTree rejection,
  incomplete installations, and non-Windows configuration.
- CI tests prove a registered Git case remains a direct Git invocation on Windows.
- The full Revisor test and syntax suites pass.
- Operationally, retry Anatomia #230 and confirm its registered submodule case
  reaches the repository tests.
