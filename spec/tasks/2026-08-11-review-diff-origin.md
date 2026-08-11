---
task: review-diff-origin
project: Revisor
kind: 実装
status: done
created: 2026-08-11
source_session: lictor-8327f518-9ed1-44f9-b63e-c709e33160bb
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# 審査の差分起点を merge repository の base ref に揃える

## 目的

`spec/feature/review-diff-scope.md` の規則 1 を実装へ反映する。 審査へ渡す差分は、
実際に squash 先となるリポジトリ (Revisor 所有の merge repository) の base ref を起点と
する。 登録元 checkout の base ref は `checkout-publication.md` の条件を満たすまで追随
しないため、 そこを起点にすると他 PR がマージしたぶんまでこの PR の変更として審査へ渡り、
`merge-risk` の `diff_size` を押し上げて自動マージを不要に止める (Cc #358 / #341)。

## 完了条件

- 審査へ渡る差分に、 他 PR がマージしたぶんの変更が含まれない
- 登録元 checkout の base ref が古いままでも、 差分の起点が merge repository の base ref
  になっている
- 審査経路が登録元 checkout の base ref を読んでいないことを呼び出し元の列挙で示せる
- 登録元と merge repository の base を意図的にずらした fixture による回帰テストがあり、
  修正前のコードでは落ちる

## スコープ (編集可ディレクトリ)

- `src/workspace.mjs` — 差分起点の解決 (`resolveReviewDiffOrigin`)
- `src/local-pr-service.mjs` — 審査要求への `reviewRootPath` 付与
- `src/runner.mjs` — 審査 worktree の準備呼び出し
- `test/` — 回帰テスト

## 結果 (2026-08-11)

- base SHA と merge-base を merge repository から、 head SHA と clean 判定を登録元
  checkout から読むよう分離した。 merge-base は head の祖先なので、 使い捨て worktree は
  従来どおり登録元 checkout に作れる (autofix の反映先と Anatomia の project path は不変)。
- `prepareLocalWorktrees` は `reviewRootPath` 欠落を拒否する。 登録元 base への暗黙の
  フォールバックは残さない。
- 回帰テスト `the review diff starts at the merge repository's base, not the stale
  registered one` は、 base 解決を登録元へ戻した複製ツリーで失敗することを確認済み。
- 乖離 2 (`assertReviewedContentUnchanged`) は Rv #384 の担当なので触れていない。
