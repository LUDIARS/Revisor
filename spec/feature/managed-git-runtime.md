---
type: feature
title: "managed-git-runtime — deterministic Git for review operations"
description: "Revisor owns the Git for Windows distribution used by workspace, publication, and registered Git test operations instead of resolving a desktop client's Git from PATH."
service: revisor
domain: managed-git-runtime
tags:
  - git
  - windows
  - process
status: implemented
related:
  - ./runtime-execution.md
  - ./local-workspace.md
  - ../architecture.md
  - ../plan/problem_logs/2026-08-09-dubious-ownership-blocked-merge.md
updated: 2026-08-09
---

# managed-git-runtime — deterministic Git for review operations

On Windows, Revisor does not resolve `git` from the service `PATH`. An operator
installs one complete Git for Windows distribution under
`%LOCALAPPDATA%\LUDIARS\Revisor\git`, or sets `REVISOR_GIT_ROOT` to another
Revisor-owned installation. Provisioning is explicit:

```text
npm run install:git -- --source <complete Git for Windows root>
```

The installer rejects SourceTree paths and stages the complete distribution
before publishing it at the managed target. An existing complete target is left
unchanged.

Every process request whose executable name is `git` or Windows `git.exe` is
replaced at the process boundary with the managed runtime, including requests
that supplied an explicit desktop-client path. Revisor launches its owned
`cmd\git.exe` directly. Git for Windows resolves its bundled helpers relative to
that executable; Revisor does not add a separate shell process or rewrite `PATH`.
The caller's environment remains available for hooks and authenticated
publication.

The installation must contain `cmd\git.exe`. Provisioning still copies the whole
Git for Windows distribution so commands that need bundled helpers retain them,
but Revisor's process boundary depends only on and directly launches the Git
executable.

Revisor fails closed when the runtime is absent or incomplete. SourceTree paths
are refused even when supplied through `REVISOR_GIT_ROOT`.

## Repository trust

### SPEC-MANAGED-GIT-TRUST: Revisor-only global Git trust

Each Git process receives `safe.directory=<cwd>` as command-scoped configuration.
The cwd is already an explicit Revisor input: a registered repository, a branch
worktree checked for cleanliness, or a disposable review worktree.

Command scope reaches only the repository this Git process opens itself. It does
not reach a local clone's **source** repository, which is opened by a child
`upload-pack` process that inherits neither command-line scope nor
`GIT_CONFIG_COUNT/KEY/VALUE`. Because preparing the isolated merge repository
clones from the registered checkout, command-scoped trust alone leaves every
merge for a checkout owned by another local account failing permanently.

For local clone/fetch, Revisor therefore owns a family of Git configuration files
based at `%LOCALAPPDATA%\LUDIARS\Revisor\git-trust.gitconfig`
(`REVISOR_GIT_TRUST_CONFIG` overrides the base location) and passes the matching
file through `GIT_CONFIG_GLOBAL`, which child Git processes do inherit. Each
immutable, content-addressed file includes the operator's own global configuration
when it exists and declares only the resolved registered root and Git-reported
absolute git directory. Ordinary managed Git commands retain the caller's global
configuration and receive no Revisor trust file. No configuration uses
`safe.directory = *`.

A host where the file cannot be resolved or written still runs Git, with the
command-scoped trust alone.

Local clone/fetch transport is the one case where Git opens two repositories:
the process cwd and the explicitly registered source. That boundary adds the
resolved registered root and Git-reported absolute git directory both to argv and
to the invocation-scoped protected configuration inherited by `upload-pack`.
Control characters are rejected before a registered path can become config text.

Asking Git for that absolute git directory already opens the source, so the
resolution step carries trust itself; otherwise the contaminated checkout is
refused before clone is ever reached. Only paths derived from the registered
root — the root and its conventional `.git` entry — are trusted at that point,
never a path guessed from Git output. The startup readability check opens the
same registered checkouts and carries the same command-scoped trust, so a
checkout Revisor can merge is not reported unreadable at boot.

Windows registered test cases normally use `cmd.exe` for command shims. A case
whose configured executable is Git stays a direct process request, so it
passes through the same managed Git boundary. Other registered commands retain
their existing shim behavior.

On non-Windows hosts the service uses `REVISOR_GIT_BIN` when set and otherwise
uses the host's `git` executable.
