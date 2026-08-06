---
title: Managed Git shell spawn blocked local PR registration
date: 2026-08-06
status: fixed
service: revisor
---

# Managed Git shell spawn blocked local PR registration

## Symptom

Local PR registration failed before review with:

```text
git rev-parse failed: spawn ...\Revisor\git\usr\bin\sh.exe ENOENT
```

The managed `sh.exe` existed and could be started interactively, but Revisor's
Git boundary still made every Git command depend on spawning that extra process.
Restarting Revisor did not recover registration.

## Cause

Windows Git invocations were wrapped in `usr\bin\sh.exe` only to prepend bundled
helper directories before executing `cmd\git.exe`. This added an unnecessary
executable boundary to all repository inspection, review, test, and publication
operations.

## Resolution

Revisor now spawns its managed `cmd\git.exe` directly and passes the existing
command-scoped `safe.directory` option and caller environment unchanged. The
installer continues copying the complete Git for Windows distribution, while
runtime validation requires the executable Revisor actually launches.

## Regression coverage

The managed Git invocation contract asserts that the command is the owned
`git.exe`, arguments are passed directly, and no shell wrapper is introduced.
