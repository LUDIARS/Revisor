---
task: managed-git-clean-filter
project: Revisor
kind: 実装
created: 2026-08-12
memory_links: []
---

# managed git 経由の add で clean filter が失敗する

## 目的

`test/workspace.test.mjs` の `the shared git boundary preserves a working LFS clean filter` が
main で落ち続けている。 managed git 経由の `git add` がリポジトリ設定の clean filter を
実行できていない。 テストの期待値ではなく実行環境側の問題なので、 managed git の
環境構築を直す。

## 現象

```
fatal: asset.bin: clean filter 'lfs' failed
```

テストは `filter.lfs.clean` に `node "<script>"` を設定し、 `revisorGit(repoPath, ["add", ...])`
で追加する。 素の git では通り、 managed git では落ちる。 このテストは LFS 実行ファイルを
使わず、リポジトリ設定の `node` clean filter を使うため、ホストの git-lfs 導入状況は原因ではない。

`gitTrustEnv` は `GIT_CONFIG_GLOBAL` を Revisor の trust config に差し替える。 filter は
リポジトリ ローカル設定なので効くはずで、 失敗するのは filter コマンドを起動する側の環境
(PATH / シェル解決) の可能性が高い。 未検証。

2026-08-11 の worker-pool タスクでも「本件とは別」として対象外に置かれ、 そのまま残っている。

## 完了条件

- 落ちている原因が特定されている (PATH か、 シェル解決か、 managed git の同梱内容か)。
- managed git 経由でもリポジトリ設定の clean filter が動く。 動かせない事情があるなら、
  その制約が spec に書かれ、 テストは制約を検証する形に置き換わっている。
- `npm test` が全件 pass する (2026-08-12 時点で残る唯一の失敗がこれ)。

## スコープ (編集可ディレクトリ)

- `src/git-runtime.mjs` — managed git の env 構築
- `src/git-trust.mjs` — trust config
- `src/workspace.mjs` — テストが通る shared git boundary
- `test/workspace.test.mjs` — 期待値 (制約が確定した場合のみ)
