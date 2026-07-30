---
type: feature
title: "review-gate — マージ可否判定ポリシー"
description: "ローカル PR の審査結果を reasons (ブロック) / advisories (非ブロック) に振り分ける判定ポリシー。docs-only 変更は対象ドメイン欠如を advisory に緩和し、ドメインレビュー自体は維持する。"
service: revisor
domain: review-gate
tags:
  - merge-gate
  - policy
  - docs-only
status: implemented
related:
  - ../architecture.md
updated: 2026-07-30
---

# review-gate — マージ可否判定ポリシー

`src/review-gate.mjs` が正本。審査 1 回分の材料 (CI 結果・Anatomia 最終解析・
complexity 差分・レビュアー出力・leakage スキャン) を受け取り、
**reasons (マージブロック)** と **advisories (表示のみ)** に振り分ける。

## ブロック条件 (reasons)

- 登録テストの失敗
- 対象ドメイン欠如 (**docs-only 変更を除く**、下記)
- `spec_linkage` 以外の Anatomia ゲート不合格 (ゲート名なしの検証失敗もブロック)
- severity=error の変更行アーキテクチャ違反
- complexity スコアの閾値超過低下
- レビュアーの `PR_GATE_NEEDS_HUMAN` 報告
- 情報流出所見

## advisory 条件 (非ブロック)

- `spec_linkage` ゲート不合格
- 孤立関数 (orphan)
- error 未満のアーキテクチャ違反
- **docs-only 変更の対象ドメイン欠如**

## docs-only 緩和 (neco 決定 2026-07-30)

ドキュメントは docs-only 変更にとってそれ自体がドメインであり、コード対象
ドメインの欠如でブロックするのは不合理。ルールは緩和し、ドメインレビューは
維持する。

- 判定: `isDocsOnlyChange` — 変更ファイルが 1 件以上あり、全てが
  `.md/.markdown/.mdx/.txt/.adoc/.rst` のとき docs-only。
  パス列挙は `git diff --name-only -z` (非 ASCII パスの C-quote 回避) と
  `git ls-files --others --exclude-standard -z` の和集合。`git diff` は追跡済み
  ファイルしか報告しないため、後続の `git add --all` がコミットする未追跡の
  新規ファイルを取りこぼさないよう同じ除外規則で併せて列挙する。
- 再判定: 最終ゲートは**レビュー後の差分**で docs-only を判定し直す。autofix が
  コードへ及んだ変更はもう docs-only ではなく、対象ドメイン欠如は再びブロックする。
  autofix が新規コードファイルを追加した場合も同様 (未追跡ファイルを列挙する理由)。
- 共有: 「まだコード対象ドメインを要するか」は `needsTargetDomain` が単一定義。
  マージゲート・レビュアープロンプト・humanQuestion が同じ判定を共有し、
  片方だけ緩和が効かない状態を作らない。
- 維持されるもの: 相互モデルレビューは docs-only でも実行する (仕様と記述の
  整合性チェック)。`PR_GATE_NEEDS_HUMAN`・登録テスト・leakage・他ゲートの
  ブロックは不変。
