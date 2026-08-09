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

Revisor therefore owns a Git configuration file at
`%LOCALAPPDATA%\LUDIARS\Revisor\git-trust.gitconfig` (`REVISOR_GIT_TRUST_CONFIG`
overrides the location) and passes it to every managed invocation through
`GIT_CONFIG_GLOBAL`, which child Git processes do inherit. The file includes the
operator's own global configuration when it exists, so identity, credential, and
conditional settings behave as before, and declares `safe.directory = *`.

The wildcard is deliberate. LUDIARS checkouts are written by several local
accounts — a sandboxed implementation account re-creating `.git` leaves that
account as its owner — so per-path entries would only move the outage to the
next contaminated checkout. Trust is scoped instead by *who reads the file*:
only Revisor's own Git invocations, never the operator's global configuration.

A host where the file cannot be resolved or written still runs Git, with the
command-scoped trust alone.

Windows registered test cases normally use `cmd.exe` for command shims. A case
whose configured executable is Git stays a direct process request, so it
passes through the same managed Git boundary. Other registered commands retain
their existing shim behavior.

On non-Windows hosts the service uses `REVISOR_GIT_BIN` when set and otherwise
uses the host's `git` executable.
