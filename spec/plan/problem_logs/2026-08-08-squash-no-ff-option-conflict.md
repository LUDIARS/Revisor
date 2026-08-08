# Squash merge rejected by incompatible Git options

- Date: 2026-08-08
- Status: fixed
- Area: local PR merge worktree
- Severity: high

## Summary

Every local PR squash merge failed before applying changes because Revisor invoked
`git merge` with both `--squash` and `--no-ff`.

## Evidence

The merge workflow reported:

```text
fatal: options '--squash' and '--no-ff.' cannot be used together
```

The same failure caused the registered local merge tests to fail.

## Root cause

`LocalMergeService` attempted to force a non-fast-forward result while preparing
a squash merge. Git defines squash merges as a staged, single-parent result and
rejects the explicit `--no-ff` option combination.

## Correction

Invoke `git merge --squash --no-commit <headSha>` without a fast-forward option.
The existing local merge test exercises the complete squash-merge path.
