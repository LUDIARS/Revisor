# Authenticated publisher blocked by the global pre-push hook

- Date: 2026-08-05
- Status: fixed in working tree
- Area: remote publication
- Severity: high — every approved local PR remains unmergeable

## Summary

This is a recurring merge-path regression. Revisor completed review and the
pre-merge checks, but its authenticated publication of an approved squash
commit was rejected by the shared LUDIARS pre-push guard.

## Evidence

On 2026-08-05, merging local PR #209 failed with:

```text
[pre-push] LUDIARS repository direct push to refs/heads/main is prohibited.
Set ALLOW_MAIN_PUSH=1 only for an intentional exception.
```

The failure was reported as `Authenticated git push failed` from
`src/authenticated-git.mjs`. Local PRs #207, #208, and #209 were all Test OK
but could not advance their registered base branches.

After the publisher marker mismatch was fixed, the next publication attempt
correctly reached the leakage scan but was blocked by the intentionally fake
GitHub token literal in `test/push-guard.test.mjs:54`. No refs were sent to
GitHub in either failure.

## Regression Context

Revisor installs its managed hook in front of any pre-existing hook. The
authenticated publisher already identifies itself with `REVISOR_PUBLISHING=1`,
but the shared pre-existing guard requires `ALLOW_MAIN_PUSH=1`. The two
contracts were not kept aligned.

## Cause

`authenticatedEnvironment` did not set the explicit exception understood by
the shared guard. As a result, Revisor's own narrowly scoped publisher was
indistinguishable from an unauthorized direct main push to that guard.

## Fix Requirements

- Set `ALLOW_MAIN_PUSH=1` only in the environment created for Revisor's
  authenticated Git child process.
- Keep ordinary shells, sessions, and unauthenticated Git commands unchanged.
- Preserve the Revisor-managed push guard and its publication validation.
- Construct secret-shaped test sentinels from source fragments so the scanner
  still observes the complete value only inside its isolated fixture repository.

## Verification

A regression test should inject a process runner into authenticated Git and
assert that its child environment contains both `REVISOR_PUBLISHING=1` and
`ALLOW_MAIN_PUSH=1`, without exposing the installation token.

The existing push-guard test continues to exercise a complete token-shaped
value at runtime without committing that signature as a source literal.

Operational verification is a successful Revisor-managed merge of local PR
#209 followed by #207 and #208.

## Follow-up

Keep the shared guard and Revisor publisher marker names synchronized if either
contract changes again.
