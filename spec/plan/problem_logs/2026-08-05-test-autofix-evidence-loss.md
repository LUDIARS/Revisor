# Test autofix model failure discards registered-test evidence

- Date: 2026-08-05
- Status: fixed in working tree
- Area: local PR registered tests / reviewer autofix
- Severity: high — the blocking test cannot be diagnosed from the PR result

## Summary

When a registered test fails and the test-autofix reviewer also fails, Revisor replaces the
captured test result with `Test autofix model failed; output was withheld from the Check Run.`
The model output must remain withheld, but the already-redacted registered-test evidence must
remain visible. This is a recurring operational regression because retries reproduce the same
opaque terminal result.

## Evidence

- Anatomia local PR #230 failed repeatedly on 2026-08-05 with the generic model error.
- `runRegisteredTests()` captured failed command output through `captureFailedTestOutput()`.
- `runTestAutofixLoop()` then threw before `LocalPrReporter.completed()` could persist `ci`.
- A fresh worktree reproduced the hidden first failure as
  `fatal: transport 'file' not allowed` while cloning `lib/aiformat`.
- The already-initialized task worktree passed install, 197 test files / 1245 tests, and typecheck,
  demonstrating why the fresh-worktree output was necessary to identify the environment delta.

## Regression Context

Failed registered-test output is intentionally redacted and tail-bounded in `src/test-output.mjs`.
That evidence is persisted for ordinary action-required results, but was lost only when the
optional repair model failed.

## Cause

`runTestAutofixLoop()` treated a repair-model failure as a worker exception. The queue's failed
projection records only the exception message, so the prior `ci` array never reached the PR store.

## Fix Requirements

- Keep reviewer stdout/stderr withheld.
- Return the captured `ci` through the normal action-required review result.
- Distinguish model failure from stalled and exhausted autofix attempts.
- Do not rerun tests when the model made no successful change.

## Verification

- Add a unit regression test proving `status=model_failed`, the original `ci` is retained, model
  output is absent, and registered tests are not rerun.
- Run the Revisor test suite and syntax checks.
- Retry Anatomia #230 and verify its failed command name, exit code, and bounded output appear.

## Follow-up

After deployment, use the newly visible #230 evidence to correct its registered-test environment
and resume the review without a human guess about which command failed.
