---
task: state-store-concurrency-flake
project: Revisor
kind: テスト
created: 2026-08-12
memory_links: []
---

# 全体実行のときだけ落ちる state-store の並行テスト

## 目的

`test/state-store-concurrency.test.mjs` の
`concurrent CLI processes preserve every PR and allocate unique numbers` が、 `npm test` の
全体実行では落ち、 単体実行では通る。 落ちる条件を特定して安定させる。 並行時の PR 番号
採番という、 壊れると実害の大きい箇所を検証しているテストなので、 flaky のまま放置しない。

## 観測 (2026-08-12)

全体の `npm test` を回した際に 1 度失敗した
(539 件中 2 失敗、 うち 1 件はこれ、 もう 1 件は既知の LFS)。 同じ checkout で
`--test-name-pattern` を使って単体実行すると pass する。

このテストは CLI プロセスを複数起動して同時に state を書く。 全体実行では他のテストも
プロセスを起動しているため、 負荷またはタイムアウト依存で落ちている可能性が高い。 ただし
「負荷で落ちた」と「排他が実際に破れた」は外から見て区別が付いていない。 後者なら本番の
採番が壊れる話なので、 flaky と断定する前に切り分ける。

## 原因追記 (2026-09-03)

8 プロセスを同時に起動すると、 SQLite がファイルを作成してから header を書くまでの
zero-byte 状態を別プロセスが旧 JSON と誤認していた。 WAL への初回切り替えも
`busy_timeout` の handler を通らず、 `SQLITE_BUSY` が即時に返る場合があった。

## 完了条件

- 失敗が再現する条件が分かっている (並行数 / タイムアウト / ファイルロック競合のどれか)。
- 排他そのものが破れていないことが確認されている。 破れているならそれを直す。
- 全体実行で安定して pass する。 タイムアウト調整で済ませる場合も、 何を待っているのかが
  テストに書かれている。

## スコープ (編集可ディレクトリ)

- `test/state-store-concurrency.test.mjs`
- `test/state-store.test.mjs`
- `test/fixtures/state-store-writer.mjs`
- `src/revisor-db.mjs`
- `src/state-store.mjs`
