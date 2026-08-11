---
task: base-relanding
project: Revisor
kind: 実装
status: done
created: 2026-08-11
source_session: lictor-8327f518-9ed1-44f9-b63e-c709e33160bb
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# base への載せ替えを Revisor が受け持つ

## 目的

`spec/feature/review-diff-scope.md` の規則 3 を実装へ反映する。 他 PR が 1 本マージされて
base が進んだとき、 衝突していない PR まで `action_required` に落として提出元セッションに
手で rebase させる運用をやめる。 載せ替えは merge repository の中で決定的に実行でき、
人間の判断を必要としない。

手で回していた手順と等価な処理をサービス側で行う:

```sh
git reset --hard <現在の base>
git merge --squash <head>
```

## 完了条件

- 載せ替えが Revisor 所有の merge repository の中だけで行われ、 登録元 checkout の
  ref・index・worktree・stash が載せ替えの前後で変化しない
- 提出元ブランチの履歴を Revisor が書き換えない
- 衝突しない限り `action_required` にしない。 base が進んだだけの PR が、 セッションの
  再 rebase 無しに取り込める
- 衝突したときだけ提出元へ返し、 返す情報に衝突したファイルの一覧が含まれる。 自動解決
  はしない
- 上記を覆う `test/` の回帰テストがある

## スコープ (編集可ディレクトリ)

- `src/base-relanding.mjs` (新規) — 現在の base の上へ head の正味の変更を載せる
- `src/local-merge.mjs` — squash merge 経路からの利用と衝突報告
- `src/errors.mjs` — 衝突ファイル一覧の搬送
- `test/` — 回帰テスト

## 結果 (2026-08-11)

- 載せ替えを `src/base-relanding.mjs` (`relandHeadOnBase`) として独立させ、 squash merge
  経路がこれを使う。 使い捨て worktree を現在の base に detach して作り、 そこへ
  `merge --squash --no-commit` するので、 merge repository 自身の ref・index・作業ツリーも
  含めて何も動かさない。
- 衝突時は index の unmerged entry から衝突ファイル一覧を読み、 `MergeConflictError`
  (`conflictedPaths` + 一覧入りメッセージ) として提出元へ返す。 自動解決はしない。
  盤面には `reasons` として一覧がそのまま出る。
- 既存のマージ経路は元から「進んだ base の上へ squash」する形だったので、 非衝突時の
  取り込みは以前から動いていた。 本タスクで新たに固定したのは、 衝突ファイル一覧の
  返却と、 「登録元 checkout の ref・index・作業ツリー・stash が載せ替えの前後で不変」
  「base が進んだ後の非衝突 PR が再 rebase 無しに取り込める」の回帰テストである。

## 対象外

- 乖離 2 (`assertReviewedContentUnchanged` の置き換え) は Rv #384 の担当。 本タスクでは
  触れない。
