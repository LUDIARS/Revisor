---
task: "Discord 完全レビュー報告"
project: "revisor"
kind: "実装"
created: "2026-09-12"
---

# Discord 完全レビュー報告

## 目的

Discord 利用者が Revisor を開かずに local PR のレビュー開始、段階、検査、所見、最終結果を読めるようにする。

## 受け入れ条件

- C-7 updateReviewReport(report, entry): attempt ごとに安定 id の安全なレビュー報告を置換記録する
- local PR 詳細と open 一覧は任意の `reviewReport` を既存フィールドを失わず返す。
- stale job/head は現在の attempt と `reviewedHeadSha` を上書きしない。

## 完了条件

- review report の永続化・API 投影・未実行の回帰テストを追加する。
