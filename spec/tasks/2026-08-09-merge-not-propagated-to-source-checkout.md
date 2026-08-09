---
task: merge-not-propagated-to-source-checkout
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - feedback-revisor-merge-blocked-triage
  - project-revisor-local-pr-workflow
---

# マージ済みなのに登録元チェックアウトへ反映されない

## 目的

2026-08-09、Anatomia の local PR #380 / #390 で連続して発生した。

`POST /v1/prs/local/:id/merge` は Concordia 経由で 502 (`local_pr_merge_failed`) を
返したが、**マージ自体は成功していた**:

- Revisor の PR state は `merged` / `test_ok`
- merge リポジトリ (`%LOCALAPPDATA%\LUDIARS\merge-repositories\ludiars-anatomia-...`)
  の `main` は squash commit まで進んでいた
- 一方、登録元の共有チェックアウト `E:\Document\Ars\Anatomia` の `main` は
  **squash 2 本分 (自分の PR と直前の #378) 手前で止まったまま**だった

結果として、Revisor 自身が `anatomiaFolder`/`dist` から起動する Anatomia は
**マージ済みの修正が入っていない古い dist** で審査を続けていた。今回は人手で
`git merge --ff-only` + `npm run build` を行って埋めたが、次のマージでも同じことが起きる。

失敗が Cc の 502 にマスクされ (`Revisor の生の失敗内容は endpoint / 設定情報を
含み得るのでローカル API 経由で返さない` という設計のため)、
呼び出し側からは「マージが失敗した」ようにしか見えないことも問題を長引かせた。

## 完了条件

- マージ成功後、登録元チェックアウトの base ブランチが同じ commit まで進むこと。
  進められない場合 (dirty / 別ブランチ checkout 中など) は、**PR を merged にする前に
  検出して明示的に失敗させる**か、少なくとも「マージ済みだが未反映」という状態を
  API とログで区別できるようにする。
- 「PR state は merged なのに登録元は古い」という不整合を検知できる手段を持つこと。
- 失敗理由が呼び出し側に伝わらない件への対処: Cc へ返す本文を伏せる方針は維持しつつ、
  Revisor 側のログに**必ず**失敗イベントを残す。今回は Revisor の構造化ログに
  該当イベントが 1 行も出ていなかった (`event: merge_*` は自テストのものだけ)。
- 手順を spec に残す。人手復旧が必要になった場合の ff 手順も含める。

## スコープ (編集可ディレクトリ)

- `src/`
- `spec/`
