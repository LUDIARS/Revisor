# 中断された local PR 審査が retry 不能になる

- Date: 2026-08-11
- Status: fixed in working tree
- Area: daemonless review worker / local PR retry
- Severity: high — 審査中の local PR が手動操作だけでは復旧不能になる

## Summary

回帰: 審査ワーカーが試行上限まで停止した後、local PR は `checkStatus=queued` のまま残る一方で job を失う。`revisor pr retry <n>` は審査中と誤認して同一 head の再投入を拒否し、head を変更しなければ復旧できなかった。

## Evidence

- 2026-08-11 に Concordia #474 / #475 と Excubitor #476 の job が `The review worker died 2 time(s); Revisor stopped retrying it.` で終了した。
- `src/local-pr-service.mjs` の `#requeue` は `queued` / `running` と同一 head だけで retry を拒否していた。
- `recoverInterruptedReviews()` は実装済みだったが、`src/worker-command.mjs` から呼ばれていなかった。

## Regression Context

常駐サーバ前提の復旧経路が daemonless CLI 移行時に失われた。PR 状態と durable job ストアの整合性を retry で確認する回帰テストが無かった。

## Cause

PR の表示状態だけを retry ガードに用いており、永続ジョブストアに該当する未終端 job が存在するかを確認していなかった。加えて、短命ワーカーの開始処理が PR 側の中断復旧を実行していなかった。

## Fix Requirements

- ワーカー起動時に `reclaimAbandoned()` の後で `recoverInterruptedReviews()` を実行し、件数をログ出力する。
- retry は対象 PR の `queued` / `running` job が実在する場合だけ同一 head を拒否する。
- 復旧失敗は PR 単位で集約し、ワーカー全体を停止させない。

## Verification

- durable job が無い queued PR の retry を許可するテスト
- running job が実在する PR の retry を拒否するテスト
- worker 起動時の中断審査復旧テスト

## Follow-up

既存の中断 PR は `revisor pr retry <n>`、または次回ワーカー起動で復旧できる。
