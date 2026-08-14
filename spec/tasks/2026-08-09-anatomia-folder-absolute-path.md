---
task: anatomia-folder-absolute-path
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - feedback-lictor-launcher-stale-worktree
  - feedback-npm-link-points-at-worktree
---

# anatomiaFolder が相対パスで、cwd 次第で別フォルダを指す

## 目的

Revisor 設定 (`%LOCALAPPDATA%\LUDIARS\revisor.config.json`) の `anatomiaFolder` が
**`"../Anatomia"`** という相対パスで保存されている。

`src/anatomia.mjs` の `resolveAnatomiaCli` は `resolve(anatomiaFolder)` するため、
解決結果は **Revisor プロセスの cwd 依存**になる。現在は catalog の
`cwd: E:/Document/Ars/Revisor` から `E:\Document\Ars\Anatomia` に解決されており
正しく動いているが、cwd が変われば静かに別のフォルダを指す。

同型の事故が過去にある: Lictor の `lictor_dev_path` が stale な worktree を指し続け、
修正が反映されないまま気づかれなかった件、および npm のグローバルリンクが
worktree を指していた件。いずれも「動いてはいるが対象が違う」ため発見が遅れた。

`bin/anatomia.mjs` は `dist/` を読むので、指し先が変われば**古いコードで審査し続ける**
ことになり、症状が「レビュー結果がおかしい」という形でしか出ない。

## 完了条件

- `anatomiaFolder` (および同種の `augurFolder`) を絶対パスで保持する。
- 相対パスが入力された場合の扱いを決める: cwd ではなく**明示された基準**
  (設定ファイルの位置など) で解決するか、保存時に絶対化して弾くか。
  「cwd 依存のまま」は選ばない。
- 起動時に解決結果を 1 行ログに出し、どのフォルダを使っているか外から確認できるようにする。
- 設定変更は token を要する正規の設定 API 経由で行うこと。
  `revisor.config.json` の直接編集は認可境界の回避であり、同ファイルは
  暗号化シークレットも保持しているため行わない。

## スコープ (編集可ディレクトリ)

- `src/`
- `spec/`

## 実装状況 (2026-08-15)

`src/config.mjs` に `resolveToolFolder(input, env)` を追加し、`readSettings`/`writeSettings`
の両方で `anatomiaFolder`/`augurFolder` を絶対パス化する。基準は cwd ではなく
`dirname(resolveConfigPath(env))` (設定ファイルの置き場所) に固定した。読み取り時にも
絶対化するため、既に相対パスで保存済みのレガシー設定にも即座に効く。
設定 API の存在確認も同じ `resolveToolFolder` を通すため、検証対象と保存先がずれない。

`src/anatomia.mjs` の `resolveAnatomiaCli` と `src/plan-advisor.mjs` の `resolveAugurCli` に
解決結果を stderr へ 1 行出す診断ログを追加した (`[anatomia] anatomiaFolder resolved to ...` /
`[plan-advisor] augurFolder resolved to ...`)。パスは JSON 文字列として出力し、設定値中の
改行などでログの行境界を崩せないようにしている。

設定変更は既存の token ゲート付き `writeSettings` 経由のみで、`revisor.config.json` を
直接編集していない。
