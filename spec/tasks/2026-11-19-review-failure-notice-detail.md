---
task: review-failure-notice-detail
project: Rv
kind: fix
created: 2026-11-19
memory_links: []
---

# Review failure notice detail

User instruction (neco, 2026-11-19): Revisor の審査失敗の理由をセッションへきちんと返し、
詳細を説明すること。

The completion notice sent to the submitting Cc session used to carry only the review
error cut at 300 chars and "再実行するか、原因を確認してください". It did not name the
failing registered checks, their exit codes, reasons or output, so the session had to open
the PR detail or re-run the whole suite to learn the cause.

Change: `failed` and `action_required` notices list failing / errored checks with name,
status, domain, failed/total, exit code, runId, reason and the redacted output tail
(20 lines / 2000 chars, at most 5 checks, truncation always stated). The review error
keeps multiple lines up to 2000 chars. A next-step line distinguishes code failures from
review-infrastructure failures.

Acceptance: the first line of each notice is unchanged (Concordia
`revisorTerminalKind` matches it); passing checks are not listed; only the stored
redacted output (`test-output.mjs`) is used; `action_required` without failing checks
is unchanged.
