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
updated: 2026-08-05
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
that supplied an explicit desktop-client path. Revisor launches `cmd\git.exe` through
the `usr\bin\sh.exe` from the same installation and puts its POSIX tools and
`git-core` helpers first on `PATH`. This keeps `git submodule` and other shell
commands inside one coherent distribution while retaining the caller's remaining
environment for hooks and authenticated publication.

The installation must contain:

- `cmd\git.exe`
- `usr\bin\sh.exe`
- `mingw64\libexec\git-core\git-sh-setup`

Revisor fails closed when the runtime is absent or incomplete. SourceTree paths
are refused even when supplied through `REVISOR_GIT_ROOT`.

Windows registered test cases normally use `cmd.exe` for command shims. A case
whose configured executable is Git stays a direct process request, so it
passes through the same managed Git boundary. Other registered commands retain
their existing shim behavior.

On non-Windows hosts the service uses `REVISOR_GIT_BIN` when set and otherwise
uses the host's `git` executable.
