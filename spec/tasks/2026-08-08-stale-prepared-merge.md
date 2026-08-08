---
task: stale-prepared-merge
project: Revisor
kind: 実装
created: 2026-08-08
memory_links:
  - spec/feature/crash-recovery.md
  - spec/feature/remote-publication.md
---
# stale な prepared merge で local PR が永久にマージ不能になる問題の修正

## 目的

prepared merge の復旧 ref (`refs/revisor/prepared/<hash>`) が、本来の用途である
「GitHub push 後・ローカル状態更新前に落ちた場合の冪等な再実行」だけでなく、
「まだ公開されていない古い prepare」まで同じ経路で再利用してしまう構造的欠陥を直す。

未公開の prepared を再利用すると `expectedBaseSha` が古い親に固定され、
`src/git-publication.mjs` の `merge-base(GitHub baseRef, expectedBaseSha) === GitHub baseRef`
検査が恒久的に false になり、当該 local PR は ref を手で消すまでマージできなくなる。

実害 (2026-08-08, LUDIARS/Concordia): base 15ba04e から 2 本の local PR が squash merge を
prepare し、先に公開された側で GitHub main が 2d76b6d へ進んだ結果、残った PR #297 の
prepared (95986da、親 15ba04e) が
`GitHub 'main' moved independently; reconcile it with local 'main' before publishing.`
で失敗し続けた。ローカル main の fast-forward でも PR ブランチのリベースでも解消しなかった。

## 完了条件

- [x] `src/prepared-merge.mjs` を新設し、prepared の再利用可否判定を単一責任で切り出す
  - [x] `readPublishedBaseSha`: GitHub の base ref の現在位置だけを ls-remote で読む (token を argv に出さない)
  - [x] `classifyPreparedMerge`: `current_base` / `published` / `stale` / `unverified` の 4 分岐を返す
- [x] `src/local-merge.mjs` の無条件再利用を判定経由に変更し、`stale` なら `forgetPreparedMerge` して現在の base の上で squash merge を作り直す
- [x] 破棄・保持の理由を PR id・prepared sha・旧 base・新 base 付きでログに残す (既定は stderr、`log` で注入可)
- [x] 作り直しのコンフリクトは既存の `MergeConflictError` で明示的に失敗させ、古い prepared に戻さない
- [x] publish 側の GitHub 検証条件 (「GitHub が独立して動いた」の検知) は変更しない
- [x] テスト: 公開済み (baseRef == prepared) の再利用・冪等復旧
- [x] テスト: 公開済み (baseRef が prepared を祖先に含む) の再利用
- [x] テスト: 未公開 + base 移動時の破棄と現 base 上での作り直し
- [x] テスト: 作り直しコンフリクト時の明示エラーと prepared ref の消滅
- [x] テスト: 破棄時の理由付きログ
- [x] `npm test` 全 green (375 pass / 0 fail)
- [x] コミット (`0b46f27` on `fix/stale-prepared-merge`)
- [ ] **残作業**: Revisor service 復帰後に同じ commit で Revisor local PR を提出する
  (GitHub PR へのフォールバックは行わない)
- [ ] **残作業**: レビュー結果 (failed / action_required) が来たら task scope 内で修正する

## スコープ (編集可ディレクトリ)

- `src/` (`prepared-merge.mjs`, `local-merge.mjs`)
- `test/` (`prepared-merge.test.mjs`, `local-merge.test.mjs`)
- `spec/tasks/`

## やらないこと

- `src/git-publication.mjs` の GitHub 検証条件の緩和 (正しい安全弁として残す)
- 共有 checkout `E:/Document/Ars/Revisor` への変更 (作業は worktree 内のみ)
