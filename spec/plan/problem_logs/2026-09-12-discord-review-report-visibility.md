---
type: problem-log
title: "Discord review report visibility"
domain: review-report
status: resolved
date: 2026-09-12
---

# Discord review report visibility

## 問題

local PR の review 状態は短い status と最終結果に偏り、Discord consumer が審査開始、
各 check の進捗、skip/reuse の理由、所見を読むには Revisor を開く必要があった。worker が
途中で終了すると、速く完了した stage の証跡も consumer に届かなかった。

## 対応

`review-report` domain に attempt 単位・stable entry id・秘密情報無害化済みの
`reviewReport` を定義し、`LocalPrReporter` が queued/running/段階 start/段階 result/
登録チェック/final の都度 local PR record へ永続化する。進捗はキュー投入ではなく実行
worker の境界で取り、結果の無い開始済み項目は interrupted として終局に残す。
詳細 API と `view=full` の一覧が全文を返し、板のカード向けの `view=summary` は
`reviewReportVersion` だけを返すため、既存の identifier-only invalidation event 後に
consumer は fresh API record を再取得できる。

## 対応関係

- 仕様: `spec/feature/complete-discord-review-report.md`
- タスク: `spec/tasks/2026-09-12-discord-complete-review-reports.md`
- domain: `spec/domains/review-report.domain.json`
- 実装: `src/review-report.mjs`, `src/local-reporter.mjs`, `src/pr-list-cache.mjs`
- 回帰テスト: `test/review-report.test.mjs`, `test/review-stage-checkpoint.test.mjs`,
  `test/pr-list-cache.test.mjs`, `test/ci.test.mjs`, `test/worker-pool.test.mjs`,
  `test/review-work.test.mjs`, `test/review-completion-notice.test.mjs`
