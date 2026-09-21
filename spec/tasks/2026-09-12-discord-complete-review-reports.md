---
task: "Discord 完全レビュー報告"
project: "revisor"
kind: "実装"
created: "2026-09-12"
---

# Discord 完全レビュー報告

## 目的

Discord 利用者が Revisor を開かずに local PR のレビュー開始、段階、検査、所見、最終結果を読めるようにする。
審査がどこまで進んだかを実行境界で記録し、途中で落ちた審査でも「走っていない段階」を走ったように
見せないことまでを目的に含める。

## 受け入れ条件

- C-7 updateReviewReport(report, entry): attempt ごとに安定 id の安全なレビュー報告を置換記録する
- local PR 詳細と open 一覧は任意の `reviewReport` を既存フィールドを失わず返す。
- stale job/head は現在の attempt と `reviewedHeadSha` を上書きしない。
- 段階は queued / start / result を別 id で記録し、結果の無い開始済み段階を interrupted、
  未開始を理由付き skipped として終局に残す。
- 登録チェック (Augur 動作ブロックを含む) の開始と結果を 1 件ずつ報告へ残す。

## 完了条件

- review report の永続化・API 投影・回帰テストを追加する。
- 実行境界で取る進捗 (worker 開始・段階 start/result・登録チェック) を spec と実装の両方に反映する。
- ローカル main の現行実装 (レビュー本文保存・Augur 動作ブロック・日本語表示文) を巻き戻さずに
  本 PR の機能をその上へ載せ直す。

## 設計・検証記録

- 着地 domain は `review-report`。`src/review-report.mjs` と対の `test/review-report.test.mjs` を
  membership に登録済み。local PR の永続化は既存 `LocalPrReporter`、一覧への投影は既存
  `summaryProjection` を再利用し、新しい投影層は作らない。
- 進捗の IPC は既存の `PrReviewWorkerPool` の message 経路へ `progress` を足して乗せる。
  task 所有権 (`task.worker !== worker`) の検証は既存のものをそのまま使い、結果の確定前に
  受領済み進捗の永続化を待つ。
- 2026-09-21 の載せ替え: ローカル main が同じ機能の先行版 (レビュー本文 `reviewerOutput`、
  Augur ドメイン動作ブロック、日本語表示文、C-8/C-9/C-10 契約) を先に取り込んでいたため、
  main 側を土台として本 PR 固有の差分だけを載せ直した。main の実装を巻き戻した箇所は無い。
- `src/ci.mjs` は main が Augur 動作ブロック経路を主経路にしたので、進捗 callback を登録テスト
  ループだけでなく準備ケースと動作ブロックの結果にも通した。通していないと台帳のあるリポジトリで
  登録チェックの進捗が 1 件も出ない。動作ブロック自体 (`runAugurDomainBundles`) は main のまま
  触らず、結果の報告は `runPlannedTests` 側に置いた。審査基盤の主経路の差分を増やさずに済み、
  Anatomia の `coupling_delta` 所見も出なくなる。
- `view=summary` は `reviewReportVersion` だけを返す。板のカードは詳細の有無しか読まず
  (`ui-pr-board-page.mjs`)、全文は詳細 API と `view=full` が返すため一覧を軽くする。
