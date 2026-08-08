# Publish squash merge aborts under fast-forward-only Git configuration

- Date: 2026-08-08
- Status: fixed in working tree
- Area: Revisor local-PR publish
- Severity: release-blocking

## Summary

A Revisor publish for Quaestor PR #322 aborted with `git merge failed` and Git's
"Diverging branches can't be fast-forwarded" guidance. This is a regression in
the publish path: an ambient `merge.ff=only` preference must not block Revisor's
intentional squash merge.

## Evidence

The reported publish error was:

```
git merge failed: hint: Diverging branches can't be fast-forwarded
fatal: Not possible to fast-forward, aborting.
```

The squash path invoked `git merge --squash --no-commit <head-sha>` without an
explicit fast-forward mode. Git therefore inherited `merge.ff=only` when that
setting was present in the target repository or its configuration scope.

## Regression Context

The failure occurred while publishing an Open / Test OK PR after Revisor release
version initialization advanced the GitHub base branch. The operation should
either reconcile the base or produce Revisor's squash commit, not expose a
machine-level merge preference as a publish failure.

## Cause

The squash merge command relied on Git's ambient merge configuration. With
`merge.ff=only`, Git rejected the divergent head/base histories before it could
stage the squash result.

## Fix Requirements

- Explicitly pass `--no-ff` to Revisor's squash merge command.
- Cover a repository configured with `merge.ff=only`.
- Keep fast-forward-only checks for branch advancement unchanged; they protect
  compare-and-swap branch updates and are not squash operations.

## Verification

A regression test configures `merge.ff=only` and asserts that a local PR is
squash-merged onto `main`. Tests were not run because this session was not
authorized to run tests.

## Follow-up

Submit the change through Revisor's local-PR workflow. Retry Quaestor PR #322
only after the Revisor change is reviewed and published.
