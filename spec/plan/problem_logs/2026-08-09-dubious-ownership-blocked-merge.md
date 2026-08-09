---
title: Dubious ownership in a registered checkout blocked every merge for that repository
date: 2026-08-09
status: fixed
service: revisor
---

# Dubious ownership in a registered checkout blocked every merge for that repository

## Symptom

Merging any local PR for the affected repository failed while preparing the isolated
merge repository:

```text
git clone failed: Cloning into '...\merge-repositories\.initialize-<id>\repository'...
fatal: detected dubious ownership in repository at '<workspace>/<repository>/.git'
'<workspace>/<repository>/.git' is owned by: <another-local-account>
but the current user is: <service-account>
fatal: Could not read from remote repository.
```

The same checkout could be read by other tooling, and no PR content was at
fault: every merge for that repository failed the same way, forever.

## Cause

Two independent facts combined.

1. The registered checkout's `.git` directory is owned by another local account.
   A history rewrite (`git filter-repo`, the leftover `.git/filter-repo/`
   directory) had been run under another local account, which re-created `.git`
   and left that account as its owner. Multiple checkouts under the workspace
   root were affected, so this was never going to stay one repository's problem.
2. Revisor only passed `-c safe.directory=<cwd>`. Git reads `safe.directory`
   from protected configuration, and command-line scope reaches only the
   repository this Git process opens itself. A local clone's **source**
   repository is opened by a child `upload-pack` process, which does not inherit
   the parent's command-line scope — and `GIT_CONFIG_COUNT/KEY/VALUE` does not
   reach it either. Both were verified against the managed Git (2.47.3):
   only a real global-scope entry works, and it must name the **gitdir**, not
   the worktree.

So the option that looked like the mitigation could not, by construction, cover
the one operation that failed.

## Resolution

Revisor now writes its own global-scope Git configuration
(`<LOCALAPPDATA>/LUDIARS/Revisor/git-trust.gitconfig`) and points every managed
Git invocation at it with `GIT_CONFIG_GLOBAL`. Environment variables are
inherited by `upload-pack`, so the trust setting applies to clone sources as
well. The file includes the user's own global configuration when it exists, so identity and
credential settings are unchanged, and declares `safe.directory = *`: the
workspace is written by several local accounts, so per-path entries would only
move the outage to the next contaminated checkout.

Startup additionally inspects every registered checkout once and reports the
ones Revisor cannot read, so an unreadable, moved, or contaminated checkout is
named at boot instead of at the moment someone tries to merge.

`scripts/repair-checkout-ownership.ps1` restores ownership of the affected
directories for the tools that do not use Revisor's trust configuration.

## Prevention

Do not run history rewrites (`git filter-repo`, `.git` re-creation) from an
isolated service account against a shared checkout. Ownership of a re-created
`.git` follows the account that created it, and the damage is invisible until
some other tool refuses the repository.

## Regression coverage

The trust configuration contract asserts the file content (user include plus
`safe.directory`), that it is never included into itself, that Git receives it
through `GIT_CONFIG_GLOBAL` without losing the caller's environment, and that a
host where the file cannot be placed still runs Git. The checkout inspection
contract asserts that every unreadable registered checkout is named, with the
ownership reason preserved on a single line.
