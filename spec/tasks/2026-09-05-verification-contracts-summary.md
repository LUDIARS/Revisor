---
task: verification-contracts-summary
project: Revisor
kind: 実装
created: 2026-09-05
memory_links: []
---
# C5 保証フラグの `summary.contracts` を受理して local PR 画面に表示する

## 目的
Augur 設計書 §6.3 の C5。Augur が `POST /api/local-prs/:id/verification` に送る
`summary.contracts: {covered, violated, uncovered}` を受理し、local PR の画面と board に
`contracts: covered n / violated n / uncovered n` を出す。disposition と merge-risk のロジックは変えない。

## 完了条件
- verification の body schema に `summary.contracts` (省略可) を追加する。指定時は
  `covered` / `violated` / `uncovered` を必須の非負整数として検証し、省略した既存クライアントには
  影響させない
- 受理した `summary.contracts` を `externalVerification` の一部として保存し、full / summary の
  API 応答に保持する
- local PR 詳細と一覧 (board) に契約集計を表示する。`summary.contracts` がない記録には表示せず、
  `violated > 0` / `uncovered > 0` は視覚的に区別する
- disposition / merge-risk / auto-merge の判定には使わない (表示のみ)
- `test/external-verification.test.mjs` に schema・保存・API 応答のテストを、`test/ui.test.mjs` に
  詳細と一覧の表示アサーションを追加する
- `spec/` の verification 契約文書を追補

## スコープ (編集可ディレクトリ)
- src (verification / local-prs / UI 関連)
- spec
- test
