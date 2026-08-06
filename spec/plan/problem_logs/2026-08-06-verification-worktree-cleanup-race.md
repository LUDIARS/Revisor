# Verification worktree cleanup race

- Date: 2026-08-06
- Status: fixed
- Area: local PR verification lifecycle
- Severity: deterministic verification cannot complete

## Summary

After Revisor began reusing completed intent reviews, the verification-only retry
for `LUDIARS/Memoria#250` reported five failed registered tests. The repository
tests did not produce application failures: the disposable review worktree was
being removed while verification was still using it.

## Evidence

The first registered case, `submodules`, failed with exit code 128:

```text
fatal: not a git repository (or any of the parent directories): .git
```

The four following cases (`install`, `unit`, `typecheck`, and `lint`) failed in
one to three milliseconds with:

```text
spawn C:\WINDOWS\system32\cmd.exe ENOENT
```

The configured `cmd.exe` and the Memoria source worktree both existed. The
combination instead indicates that the child processes' `cwd` disappeared.

## Cause

`createPrReviewRunner` returned the promise from `runPartialVerification`
without awaiting it inside the surrounding `try`. JavaScript executes `finally`
before adopting that returned promise, so `cleanupWorktrees` raced the partial
verification and removed its `head` and `base` directories.

The full-review path did not have this lifecycle error because its asynchronous
stages were awaited before control reached `finally`.

## Fix

- Await `runPartialVerification` inside the `try` block.
- Add a regression test whose registered child process waits briefly and then
  verifies that its review worktree still contains `.git`.
- Keep cleanup in the existing `finally`, where it now starts only after the
  verification result settles.

## Verification

The regression test is registered in `test/runner-verification-cleanup.test.mjs`.
No unit, integration, or startup tests were run locally in this session, per
session policy. Revisor's registered review gates will perform verification.

## Follow-up

After deploying the Revisor fix, retry `LUDIARS/Memoria#250`. Its completed
intent review should be reused and the deterministic gates should run against a
live disposable worktree.
