---
title: Local merge repository initialization rejects a sandbox-owned source
date: 2026-08-09
status: fixed in working tree
service: revisor
---

# Local merge repository initialization rejects a sandbox-owned source

## Summary

Merge preparation regressed when Revisor moved squash work into a persistent
local clone. Initialization fails before review publication when the registered
source checkout was created by the sandbox account and Revisor runs as the
interactive service account.

## Evidence

The local `git clone --no-checkout` reports `detected dubious ownership` for the
registered repository's `.git` directory and recommends a global
`safe.directory` exception. No remote access or repository permission failure is
involved; Git rejects the local source before cloning its objects.

## Cause

The managed Git boundary adds command-scoped trust for the process cwd. Clone
and fetch run with Revisor's merge-repository directory as cwd, but local
transport separately opens the registered source repository, whose path was not
included in the command-scoped trust list.

## Fix requirements

- Add only the resolved registered root and its Git-reported absolute git
  directory to clone and fetch commands.
- Keep argv execution; do not invoke a shell.
- Do not use `safe.directory=*` or mutate system, global, or repository config.
- Preserve the independent persistent clone and never modify the source
  checkout's refs, index, worktree, stash, hooks, or ignored files.

## Verification

The merge-repository regression test records clone/fetch argv and requires both
source transfers to carry the exact registered root and resolved git directory
as command-scoped `safe.directory` entries, with no wildcard. Operationally,
retry initialization from a sandbox-owned registered checkout and confirm merge
preparation reaches the existing review and publication stages.
