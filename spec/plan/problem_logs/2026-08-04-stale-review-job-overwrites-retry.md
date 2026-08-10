# Stale review job overwrites a retried local PR

- Date: 2026-08-04
- Status: fixed (2026-08-10)
- Area: local PR review queue lifecycle
- Severity: review result and notification can describe a superseded head

## Summary

Revisor local PR #200 was retried after its branch advanced from `506f72f` to
`b1f3782`. The superseded review later failed its head preflight and wrote
`checkStatus: failed` onto the same local PR even though the replacement review
was already queued. The user received a failure notification for the old head.

This is a lifecycle race: a terminal event from an older job may overwrite the
visible state of the current job for the same local PR.

## Evidence

At 2026-08-04T06:43:55.516Z, Revisor queued the replacement job for head
`b1f3782614ef20253a9fcd77c6f9976673743a79`.

At 2026-08-04T06:47:15.065Z, the older job for head
`506f72fe1bc5a3d490cfddd04794e57955b4c7fa` failed with:

```text
head SHA changed before review (expected 506f72fe1bc5a3d490cfddd04794e57955b4c7fa, found b1f3782614ef20253a9fcd77c6f9976673743a79)
```

The queue still listed the `b1f3782` replacement as queued, while local PR #200
showed `checkStatus: failed` and the older job's error.

Relevant code:

- `src/queue.mjs`: jobs are keyed by repository, PR number, and head SHA, so a
  retry after a branch update creates a distinct job while the old one may remain
  queued or running.
- `src/local-reporter.mjs`: `queued`, `running`, `completed`, and `failed` update
  the PR by `localPrId` without confirming that `job.id` and `job.request.headSha`
  still match the PR's current `jobId` and `headSha`.

## Regression Context

Retry deliberately re-resolves a moved branch and force-submits the new head.
Existing tests cover that the new head is queued, but do not keep the old job
alive long enough to prove that its later lifecycle callbacks are ignored.

## Cause

The leading cause is missing supersession checks in `LocalPrReporter`. A stale
job remains entitled to update and notify for a local PR after `#requeue` has
stored a newer `jobId` and `headSha`.

## Fix Requirements

- Ignore lifecycle callbacks whose `job.id` is not the PR's current `jobId`.
- Also require `job.request.headSha` to equal the PR's current `headSha` before
  projecting review output or sending terminal notifications.
- Preserve the stale job's own queue history for diagnostics without projecting
  it as the current local PR result.
- Define whether a retry cancels a queued superseded job or merely makes its
  later callbacks inert.

## Verification

Add a regression test that holds the first head's job open, advances the branch,
retries the PR, and then fails the first job after the replacement is queued.
The PR must remain associated with the replacement job and must not emit a
terminal failure notification for the superseded head.

No unit, integration, or startup tests were run in this session, per session
policy.

## Follow-up

Retry local PR #200 on its latest head. Until the reporter guard is implemented,
notifications from older queued jobs must be checked against the head SHA before
being treated as the current verdict.

## 2026-08-10 無限再投入としての再発と修正

未実装のまま残っていた supersession ガードが、 60 秒周期の auto-merge sweep と
噛み合って終わらない再投入になっていた:

1. sweep が open / test_ok を拾ってマージ → 審査済み内容と現在ヘッドが違えば
   `StaleReviewError`
2. `local-pr-service` が `#requeue` で force 再投入 (新 job)
3. 追い越された古い job が終わると、 `LocalPrReporter` が `localPrId` だけを見て
   **古い `reviewedHeadSha` のまま test_ok を復元**
4. 次の sweep が再び同じ stale 判定に着き、 2 へ戻る

修正は 2 層:

- `LocalPrReporter` に `#isCurrent(job)` を追加し、 PR の現在の `jobId` と `headSha`
  に一致する job の `running` / `completed` / `failed` だけを反映する。 所有権は
  `queued` が書く `jobId` が正本。 追い越された job は状態も通知も自動マージも起こさない。
  reporter は PR を読めない store を受け付けなくなった (ガードが素通りするため)。
- 同一ヘッドへの自動再審査を `STALE_REQUEUE_LIMIT` (2) で頭打ちにし、 超えたら
  `action_required` で人間の判断へ渡す。 ヘッドが動いた再審査は正当なので数え直す。
  判定に使ったヘッドは `StaleReviewError.headSha` で運ぶ。

回帰条件はどちらも `test/local-pr-service.test.mjs`:
追い越された job が現在の審査を上書きも通知もしないこと、 同じヘッドの stale が
上限を超えたら再投入せず `action_required` に落ちること。
セッション方針によりこの session ではテストを実行していない (Revisor の登録テストで検証する)。
