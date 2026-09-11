---
type: task
title: "Manual Release の local API と CLI"
domain: remote-publication
status: implemented
---

# Manual Release の local API と CLI

## 目的

UI セッションに依存せず、同一ホストの運用ツールが major/minor Release を安全に実行できるようにする。

## 完了条件

- C-1 release-state(id): store record id と owner/name の両方で version/tag/候補/未公開 commit 数を返す。
- C-2 release(id, body): confirmed major/minor request を既存の ReleaseService へ渡し、競合は 409、検証は 400 とする。
- C-3 cli release(args): local HTTP API だけを呼び、notes file の本文と expected version を送る。
- C-4 documentation(): remote-publication の API/CLI 契約と domain membership を記録する。

## 検証証跡

- `node --check src/server.mjs src/cli.mjs src/release-local-command.mjs src/release-service.mjs` と
  `git diff --check` は通過した。ユーザー指定により node:test は実行していない。
- `rg -n 'release-state|repositories/.+releases|runManualReleaseCommand|confirmed: true' src test spec`
  で API、CLI、正常・409・400 fixture、仕様への到達を確認した。
- `anatomia plan` と `git diff | anatomia verify` は、worktree 外の
  `E:/Document/Ars/logs/anatomia/2026-09-11.jsonl` への EPERM で解析前に停止した。
  コード・ドメイン定義の gate failure は出力されていない。

## 再利用探索

UI の `validateManualRelease` と `ReleaseService.release`、`collectRepositoryChanges`、
`listLocalReleaseTags` を採用した。公開トランザクションは再実装せず、既存の
publication coordinator を経由するためである。
