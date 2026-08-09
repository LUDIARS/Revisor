---
type: plan
title: "merge-stabilization-strategy — Revisor のマージを止めない方針"
description: "所有者汚染によるclone失敗の恒久対処と、rebase+squashを前提にした自動リベース・レビュー引き継ぎ・コンフリクト解決導線の方針。"
service: revisor
domain: local-merge
tags:
  - merge
  - rebase
  - review-carryover
status: proposed
related:
  - ../feature/pr-lifecycle.md
  - ../feature/local-workspace.md
  - ../feature/managed-git-runtime.md
  - ./problem_logs/2026-08-09-dubious-ownership-blocked-merge.md
updated: 2026-08-09
---

# merge-stabilization-strategy — Revisor のマージを止めない方針

マージが止まる原因は 2 種類ある。 環境側 (登録 checkout を Git が開けない) と、
運用側 (base が進んだ PR がコンフリクト扱いで滞留する)。 前者は実装済み、 後者は
本書が方針を定める。

## 決定 (neco, 2026-08-09)

1. PR の内容をちゃんと書く。
2. Anatomia による解析で、 コードの問題を LLM なしに機械的にある程度追う。
3. レビューはマージ前に行う。
4. 一度レビューしたものは再レビューしない。
5. コンフリクトが無ければ、 head が変わっていてもそのままマージする。
6. コンフリクトしたなら、 コンフリクトを解決してマージする。
7. マージはリベースマージ + スカッシュである。
8. PR を開いた時点でマージ可能かを確認する。
9. コンフリクトが無い場合は自動でリベースしてマージする。 コンフリクトがある場合は
   自動ではリベースせず、 「リベース & 解決」 ボタンを用意する。

## 現状との差分

| 決定 | 現状 | 差分 |
| --- | --- | --- |
| 5 | `assertReviewedContentUnchanged` が patch-id 不一致で再審査へ落とす | base が進んだだけの head も再審査になる。 コンフリクトの有無で判定するよう置き換える |
| 6 / 9 | `MergeConflictError` → `action_required` で人待ち。 自動復帰なし | 自動 rebase を試し、 通ればそのままマージ。 失敗時だけ UI 導線 |
| 7 | base を動かさず `merge --squash` を当てる | rebase してから squash する |
| 8 | 提出時はコンフリクトを見ない。 マージ直前に初めて判る | 提出時に判定して PR に表示する |
| 2 | Anatomia は解析済みだがマージ判定の前段に無い | LLM レビュー前の機械ゲートとして位置づける |

## 段階

- **P1 提出時のマージ可能性判定**: 隔離マージリポジトリ内で現 base への rebase を
  試行し、 結果 (clean / conflict + 対象ファイル) を PR に保持して表示する。 判定は
  登録 checkout を一切変更しない。
- **P2 rebase + squash マージ**: マージ時に head を現 base へ rebase し、 その結果を
  squash する。 コンフリクトが無ければ head の SHA 変化は問わない (決定 5)。
- **P3 レビュー引き継ぎ規則の置き換え**: 再審査の条件を「patch-id が変わったか」から
  「rebase がコンフリクトしたか」へ移す。 セキュリティスキャンはマージ直前に走る
  現行のままとし、 引き継ぎの対象にしない。
- **P4 コンフリクト解決導線**: `action_required` の PR に 「リベース & 解決」 を用意し、
  解決は担当セッションへ委譲する。 自動での強制解決は行わない。
- **P5 機械ゲートの前置**: Anatomia の解析を LLM レビューの前段に置き、 機械的に
  判る問題はレビュー枠を使わずに返す。

P1 と P2 は同じ rebase 試行を共有する。 先に P1 を入れると、 P2 の判定材料が実データで
検証できる。

## 制約

- 登録 checkout の worktree・index・ブランチは書き換えない。 rebase は隔離マージ
  リポジトリの中だけで行う (`prepareMergeRepository` の不変条件)。
- 自動リベースの再試行は 1 周につき 1 回に留める。 base が連続で動く状況では、
  隠して回り続けるより従来どおり止める。
- コンフリクト解決を自動生成のコードで埋めない。 解決は人間かセッションの担当。
