---
type: problem-log
title: "Stale prepared merge after registered base fast-forward"
domain: local-workspace
status: resolved
date: 2026-10-23
---

# Stale prepared merge after registered base fast-forward

## 問題

LUDIARS/Praeforma PR #3386 で、GitHub `main` (37295cf) が登録 checkout の `main` (b35f438)
より 2 コミット先行していたため、test_ok の PR のマージが失敗した。登録 checkout を
`git merge --ff-only origin/main` で 37295cf に進め、`pr retry` で baseSha 37295cf の
test_ok を得た後も、`pr merge` は `merge_attempt_started baseSha=b35f438` と
`merge_prepared_reused mergeCommitSha=5039b6b` (親 b35f438) を出し、
「GitHub 'main' is not contained in the local source of truth.」で失敗し続けた。

## 原因

- `merge_attempt_started` の `refs/heads/main` は登録 checkout ではなく、Revisor 所有の
  merge repository (`<state dir>/merge-repositories/<repo>`) の ref。`prepareMergeRepository`
  は head ref だけを fetch し、base は clone 作成時から一度も登録 checkout へ追従しなかった。
  このため登録 checkout を進めても merge repository の base は b35f438 のままだった。
- `classifyPreparedMerge` は prepared の親 (b35f438) と現在の base (同じく b35f438) が一致
  したため `current_base` として再利用した。「未公開のまま base が動いた prepared は再利用
  しない」判定は、base が動いたことを merge repository が知らないので発火しなかった。
- publish の検査では GitHub の 37295cf の object が merge repository に無く、`merge-base` が
  失敗して `BaseMovedError` ではない一般エラーになるため、自動 reconcile も走らなかった。
- `pr retry` (再審査) は prepared merge の復旧 ref を捨てない。prepared を捨てるのは
  `BaseMovedError` 後の reconcile と、`classifyPreparedMerge` の `rebuild` 判定だけ。

## 対応

`prepareMergeRepository` が merge 準備のたびに登録 checkout の base を private ref へ fetch し、
登録 checkout の base が merge repository の base を祖先に含むときだけ CAS で fast-forward
する (`catchUpMergeBaseFromSource`)。base が現在の登録 checkout に揃うので、未公開の
prepared merge は `classifyPreparedMerge` で `stale` → 破棄 → 現在の base 上で squash し直す。
GitHub が既に含む prepared merge は従来どおり `published` として冪等に再利用する。
merge repository が先行 (publication 前の正常状態) または分岐している場合は base を動かさない。

## 対応関係

- 仕様: `spec/feature/local-workspace.md` §「登録 checkout と merge repository の分離」,
  `spec/feature/remote-publication.md` §Consistency and recovery
- 実装: `src/merge-repository.mjs`
- 回帰テスト: `test/merge-repository.test.mjs`
- 契約: `augur.contracts.json` C-18
