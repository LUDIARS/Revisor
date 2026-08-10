---
task: local-main-behind-github
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-08-stale-prepared-merge.md
  - spec/feature/remote-publication.md
  - spec/feature/crash-recovery.md
---
# 登録 root のローカル main が GitHub main に追随していない

## 目的

local PR #354 (merge commit `417c02e`) は GitHub `LUDIARS/Revisor` の main へ公開されたが、
Revisor が登録している root (baseRef `main`) のローカル main は
`cfd6b8a` (PR #338 相当) のままで、公開済みコミットを含んでいない。

`src/git-publication.mjs` の `pushPublishedCommit` は
`merge-base(GitHub baseRef, expectedBaseSha) === GitHub baseRef` を要求するため、この状態のまま
次の Revisor local PR をマージしようとすると
`GitHub 'main' moved independently; reconcile it with local 'main' before publishing.`
で停止する。安全弁としては正しい挙動なので、直すべきはローカル側の追随。

あわせて、publish 成功後に `advanceLocalBranch` が効いていない (または後から main が巻き戻った)
経緯を確認する。`squashMergeLocalPullRequest` は publish → `advanceLocalBranch` の順で、
後者が失敗すればマージ自体が失敗するはずだが、PR #354 は merged として確定している。

## 完了条件

- [ ] 登録 root のローカル main を GitHub main (`417c02e`) へ fast-forward し、公開済みコミットを含む状態にする
- [ ] publish 成功後にローカル main が追随しなかった原因を特定する
  (`advanceLocalBranch` の失敗経路 / 外部からの巻き戻し / 別 clone での実行 のいずれか)
- [ ] 原因が Revisor 側のコードにある場合は再発防止を実装し、テストを追加する
- [ ] 稼働中の Revisor サービスが古い HEAD (`cfd6b8a`) で動いているため、
      チェックアウト更新後にサービスを再起動して #354 の修正を有効化する (Excubitor 経由)

## スコープ (編集可ディレクトリ)

- `src/` (`local-merge.mjs`, `workspace.mjs` の `advanceLocalBranch` 周辺)
- `test/`
- `spec/tasks/`

## 前提・注意

- 共有 checkout への git 操作とサービス再起動は、
  このセッションの制約 (worktree 内のみ編集可 / 再起動は Excubitor + 本体フォルダ) の外なので、
  実施者は担当セッションまたは人間とする。
- ローカル main を GitHub へ合わせる方向で reconcile する。GitHub 側を巻き戻さない。
