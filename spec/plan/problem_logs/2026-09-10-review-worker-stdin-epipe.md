# PR review worker terminated on an unhandled stdin EPIPE

- Date: 2026-09-10
- Status: fixed in working tree; runtime verification pending
- Area: runtime-execution / process.mjs
- Impact: PR #1648 could not finish its review

## Evidence

PR #1648 completed its Anatomia checkpoint at 2026-09-10T00:44:23.669Z for
head `564595da4153d82290310c901b136036030372b0`. At 00:44:23.911Z,
`review_worker_exited` recorded worker-3 / PID 49856, code 1, signal null.
The PR reported `PR review worker exited (1).` rather than a review finding.

The local worker log records `Unhandled 'error' event`, `Error: write EPIPE`,
and `src/process.mjs:60:17` at `child.stdin.end(stdin, "utf8")`.
The error was emitted on a Socket instance, on Node.js v24.14.1.

## Cause

The subprocess input pipe closed during writing. `runProcess` listened for
errors on the ChildProcess, but not its distinct stdin stream. Node terminated
the review worker on the unhandled stream event. The child command and its
reason for closing input are not identified by the retained stack trace.
No evidence currently ties this crash to the project orphan-count implementation.
Whether this is a regression from a prior stdin fix is not established.

## Fix Requirements

Subscribe to stdin errors before writing. Record input delivery failure in the
normal command result, preserve stdout/stderr and the actual exit code, and
wait for child close or the existing timeout. Even an exit code of zero must
not conceal a failed input delivery. A pipe error must not kill the review worker.

## Verification

Source inspection only; no tests or services run. A registered regression test now
covers a child closing stdin before a parent write completes: the worker must
survive, the process result must be unsuccessful, diagnostics must be retained,
and the actual child exit code must remain available. Test execution remains
pending under session policy.

## Follow-up

Re-submit PR #1648 with this fix. Runtime still executes the previously installed
Revisor code until the change is reviewed and applied; re-submission alone does
not demonstrate that the runtime fix is installed. No restart or main update was
performed by this session.
