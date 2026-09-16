---
type: task
title: "feat(review-plan): Augur 台帳があるリポは変更ドメインのバンドルだけを回す"
domain: review-plan
status: in-progress
---

# feat(review-plan): Augur 台帳があるリポは変更ドメインのバンドルだけを回す

## 目的

Augur 台帳が整備された対象リポジトリでは、Revisor の `registered_tests` を変更 business
ドメインの動作ブロックへ置き換え、無関係な全体スイートを審査で実行しない。

## 完了条件

- `C-9 runPlannedTests(input): Augur 台帳があるリポは変更ドメインの動作ブロックだけを記録し、空・失敗・未実行を区別する`
- 台帳が無いリポジトリは従来の登録全体スイート選択を維持する
- domain bundle の結果を CI と審査レポートに動作ブロックとして記録する
- empty bundle は advisory、failed と runner error はマージをブロックする

## 実装メモ

- 着地ドメインは既存の `review-plan` と `review-gate`。Anatomia `where` がこの二つを
  含む既存責務として返したため、新規 domain 宣言は不要だった。
- 既存の `runPlannedTests` の `execute` 関数注入を継続利用した。これにより Augur CLI を
  hermetic に差し替え、実 Augur や対象リポジトリの全体スイートをテストで呼ばない。
- Anatomia `plan` は既存 knowledge log の LF 制約で停止した。CLI 自体は利用可能だったため、
  指定どおり `where` / `context` へフォールバックした。未解決の設計判断はない。

## 検証結果

- `node --test test/review-plan.test.mjs test/review-gate.test.mjs test/ci.test.mjs test/review-report.test.mjs`: 69 passed
- `git diff | anatomia verify --repo <worktree>`: PASS（5 gates）
- `C-9`: covered 6 / observed 6 / violations 0
