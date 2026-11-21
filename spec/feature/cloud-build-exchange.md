---
type: feature
title: "cloud-build-exchange — 外部実行環境とのビルド・テスト依頼／結果の受渡し"
description: "Revisor が外部 (Claude Cloud 等) に渡すビルド・テスト依頼を、入力明細とハッシュ付きで書き出し、戻った結果を依頼と照合して分類・記録する。"
service: revisor
domain: local-pr-lifecycle
status: implemented
related:
  - ./external-verification.md
  - ./non-code-registered-tests.md
updated: 2026-11-21
---

# cloud-build-exchange — 外部実行環境とのビルド・テスト依頼／結果の受渡し

## 目的と範囲

本社の登録テスト (例: Figmentum の native build、クリーン 8 分 58 秒・主要 3 工程 294 ソース) を
外部の実行環境へ分割して流すための **受渡し形式と検査** を定める。本機能が行うのは次の 3 つだけ。

1. 依頼 (request) の書き出し: PR・head・run・分割 ID、対象テスト、入力ファイル明細とハッシュ、
   要求する OS / ツールチェーンを記した `request.json` と、明細どおりの入力ファイルを outbox に置く。
2. 結果 (result) の受け取り: 外部から戻った `result.json` と完全ログを依頼と照合して分類する。
3. 記録 (ledger): 分類結果を交換ディレクトリの ledger に追記し、依頼単位の集計を返す。

転送 (Google Drive 等へのアップロード・ダウンロード)、外部での起動、課金は **範囲外**。
outbox / inbox は普通のディレクトリで、運搬は人間または後続の連携が行う。データベース丸ごと・秘密・
`.env` 類は入力に含めない (含めようとした依頼は書き出し時に拒否する)。

## 保証の違い (external-verification との関係)

`external-verification` の Augur 記録は、Revisor が受理済みと認めたテスト実行として
runtime verification の blocker と merge-risk の動作確認要因を解除する。
本機能の結果は **実行者の自己申告** であり、Revisor はログとハッシュの整合と依頼との一致しか確かめられない。
したがって:

- 結果は PR record (`externalVerification`) に書かず、disposition・merge-risk・auto-merge に使わない。
- 記録には常に `guarantee: "executor-reported"` を付け、Augur 保証と表示上も区別する。
- 依頼と食い違う結果 (別 head・別環境・古い・改ざん) は `rejected` とし、成功に数えない。

## 依頼 (request.json)

`schema: "revisor.cloud-build.request/1"`。正規化 JSON (キー昇順・空白なし) の SHA-256 を
`requestDigest` とする。

| field | 内容 |
|---|---|
| `requestId` | `<pr>-<head 先頭12>-<runId>-<shardId>` 由来の安定 ID (英数字・`.`・`-`・`_`) |
| `pullRequest` | `{ id, number, repository }` |
| `headSha` | 40 桁 hex |
| `runId`, `shardId` | 依頼側の run と分割 ID。`shard: { index, count }` を併記 |
| `tests` | 対象テスト名の配列 (登録テストの `name`)。1 件以上 |
| `environment` | `{ os: "windows"\|"linux"\|"macos", arch, toolchain: { name, version }, cmake? }` |
| `inputs` | `[{ path, size, sha256, gitBlob }]`。path はリポジトリ相対の POSIX 形式、昇順・重複なし |
| `nonce` | 依頼ごとの 128bit 乱数 (hex)。結果に同じ値が戻ることを要求する |
| `issuedAt`, `expiresAt` | ISO 時刻。既定の有効期限は 24 時間 |

入力は `git rev-parse <head>:<path>` の blob と作業ツリーの `git hash-object <path>` が一致する
ファイルだけを受け付け、作業ツリーの未コミット内容を head の内容として渡さない。リポジトリ外・
絶対パス・`..`・秘密らしい名前 (`.env*`、`*.pem`、`*.key`、`credentials*`、`id_rsa*`、`*.sqlite*`、`*.db`)・
1 ファイル 64 MiB 超は拒否する。

## 結果 (result.json + ログ)

`schema: "revisor.cloud-build.result/1"`。

| field | 内容 |
|---|---|
| `requestId`, `shardId`, `headSha`, `requestDigest`, `nonce` | 依頼からの写し。全て一致必須 |
| `status` | `passed` \| `failed` \| `not_executed` |
| `exitCode` | `status` が `not_executed` 以外では整数必須 |
| `durationMs` | 非負整数 |
| `startedAt`, `finishedAt` | ISO 時刻 |
| `environment` | 実行した環境 `{ os, arch, toolchain: { name, version }, cmake? }` |
| `tests` | `[{ name, status, exitCode?, durationMs? }]` |
| `log` | `{ file, sha256, size }`。`file` は結果ディレクトリ内の相対名 |

## 分類

照合は次の順に行い、最初に該当したものを結果とする。`rejected` は理由コードを持つ。

1. `invalid` — schema・型の不一致。
2. `rejected: unknown_request` — 該当する依頼が交換ディレクトリに無い。
3. `rejected: request_digest_mismatch` / `nonce_mismatch` — 依頼の写しと一致しない (別依頼の流用・偽造)。
4. `rejected: head_mismatch` — `headSha` が依頼と違う (別 head)。
5. `rejected: environment_mismatch` — `os`・`arch`・ツールチェーン名・版が要求と違う。
   **Linux の結果を Windows/MSVC の依頼の代わりにしない** のはこの規則による。
6. `rejected: log_missing` / `log_hash_mismatch` — ログが無い、またはハッシュ・サイズが違う。
7. `rejected: stale` — `finishedAt` が依頼の `expiresAt` より後、または `issuedAt` より前。
8. `rejected: test_set_mismatch` — 結果の `tests` の名前集合が依頼と違う。
9. `duplicate` — 同じ `requestId` の受理済み結果が既にある。内容 (正規化 JSON とログ hash) が同じなら
   `duplicate: identical` で何も変えず、違えば `rejected: conflicting_duplicate` とし先の記録を残す。
10. それ以外は受理し、`status` が `passed` かつ全テスト `passed` なら `passed`、`not_executed` なら
    `not_executed`、それ以外は `failed`。`status: passed` なのに失敗テストや非 0 終了がある結果は
    `rejected: inconsistent_status` とする。

依頼単位の集計 (`status` コマンド) は run の全 shard について、受理済み `passed` / `failed` /
`not_executed` / 未着 (`missing`) を数え、`complete` (全 shard passed)、`failed` (受理済み failed あり)、
`partial` (未着・not_executed あり) を返す。古い head の run は対象にしない。

## ledger

`<exchange>/ledger.jsonl` に 1 行 1 記録で追記する。記録は `{ recordedAt, requestId, runId, shardId,
headSha, classification, reason?, status?, exitCode?, durationMs?, logSha256?, resultDigest,
guarantee: "executor-reported" }`。結果ファイル本体は `<exchange>/results/<requestId>/` に
コピーして保管し、ledger からはハッシュで紐付ける。

## CLI

```
revisor cloud-build request --exchange <dir> --repo <path> --pr <id> --number <n> --repository <owner/name>
  --head <sha> --run <id> --shard <index>/<count> --test <name>... --os <os> --arch <arch>
  --toolchain <name>@<version> [--cmake <version>] --input <path>... [--ttl-hours <n>]
revisor cloud-build ingest --exchange <dir> --result <dir>
revisor cloud-build status --exchange <dir> --run <id> --head <sha>
```

`request` は `<exchange>/outbox/<requestId>/` に `request.json` と `inputs/` を作る。`ingest` は分類結果を
JSON で出し、`invalid` / `rejected` は終了コード 2 とする。

## 未決事項 (人間判断)

- 送信先: Claude Cloud の実行環境は Linux コンテナで、Windows/MSVC を実行できる確認は取れていない。
  Figmentum の MSVC 登録テストを流すには Windows 実行環境が別途要る。Linux の結果は
  `environment_mismatch` で拒否されるため、誤って代用されることはない。
- 分割単位: 既定は登録テスト 1 件 = 1 shard。CMake ターゲット単位の分割は送信先が決まってから定める。
- 起動・転送時間の実測は送信先決定後。
