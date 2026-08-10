---
task: version-file-registered-checkout
project: Revisor
kind: 実装
status: done
created: 2026-08-10
memory_links:
  - src/version-root.mjs
  - spec/feature/local-workspace.md
  - spec/feature/remote-publication.md
---

# 公開時のバージョンファイルを登録 checkout から読む

## 目的

新しく初期化したリポジトリが**構造的に publish できない**。初期化直後でも
`.revisor-version must be committed on the base branch before publishing.` で拒否され続ける。

原因は、`.revisor-version` を扱う 3 箇所のうち **公開だけが別のリポジトリを見ていた**こと。

| 操作 | 見ているリポジトリ |
|---|---|
| 状態表示 `inspectLocalVersionState` | 登録 checkout |
| 初期化 `initializeLocalVersion` | 登録 checkout |
| **公開 `prepareLocalVersionFile`** | **隔離マージリポジトリ** ← ここだけずれていた |

マージを隔離リポジトリへ移した際 (`local-workspace.md` の分離) に、
`local-pr-service.mjs` が `repository` を merge repository へ差し替えるようになったが、
`release-publisher.mjs` のバージョンファイル参照はそのまま隔離側を見ていた。

隔離リポジトリの base は **「初期化後は Revisor が所有し、登録 checkout から更新しない」**
規約 (`prepareMergeRepository`) を持つ。したがって初期化コミットは隔離側へ到達する経路が無く、
gate から見ると永久に未初期化のままになる。

`prepareMergeRepository` が `registeredRootPath` を返しているのはこの解決のためだが、
**どこからも読まれていなかった** (`grep` して参照 0 件)。付け替え漏れの証拠。

### 実測 (2026-08-10)

Calicula `0.1.0` / Ars `0.6.0` / Interpres `0.4.0` / Ludellus-Native `0.3.0` を
リリース初期化し、Revisor の `/api/releases` も `status: ready` を返す状態にした上で、
対応する PR (#406 / #402 / #349 / #167) を再マージしても全て同じ理由で拒否された。
本体を最新へ ff して再起動しても変わらず。

裏付け:

- 登録 checkout に対して `prepareLocalVersionFile` を単体で呼ぶと `0.1.0` を返して通る
- 隔離リポジトリ側は `git ls-files -- .revisor-version` が空
- 初期化コミット `40739bc` は隔離リポジトリから `git cat-file -e` で見えない
- `origin/main` にも `.revisor-version` は無い (初期化コミットは登録 checkout にローカルのみ)

## 完了条件

- [x] 公開が `.revisor-version` を登録 checkout から読むこと
- [x] 公開後の版数書き戻しも同じ正本へ行うこと (読みと書きがずれると版数が巻き戻る)
- [x] 解決規則が単体でテストできる形になっていること

## スコープ

- `src/version-root.mjs` (新規) — 版数の正本を解決する純関数。理由と実害を収録
- `src/release-publisher.mjs` — 読み (`prepareLocalVersionFile`) と
  書き戻し (`writeLocalVersion`) の両方を解決結果に向ける
- `test/version-root.test.mjs` (新規)

対象外:

- タグ・リリース対象コミットの参照 (`listLocalReleaseTags` / `releaseChanges` /
  `listRemoteReleaseTags`) — これらはマージコミットを持つ隔離リポジトリを見るのが正しい
- 隔離リポジトリの base 更新規約そのもの — 変えない

## 設計判断

**なぜ隔離リポジトリ側に初期化コミットを届けないのか。** `prepareMergeRepository` は
base を「初期化後は Revisor が所有し、登録 checkout から更新しない」と明示している。
publication と GitHub reconciliation だけが base を前進させてよい。ここへ初期化のために
別経路を足すと、その一点だけ規約の外に置くことになる。版数の正本は元々登録 checkout 側に
あるので、読み手を正本へ戻すほうが筋が通る。

**なぜ `--skip-worktree` の観点でも登録 checkout が正しいか。** `prepareLocalVersionFile` は
`git update-index --skip-worktree` を立てる。隔離リポジトリは `--no-checkout` かつ detached で
worktree を持たないため、この操作はそもそも意味を成さない。

## テスト

`test/version-root.test.mjs`:

- `prepareMergeRepository` を通した repository で登録 checkout 側が選ばれること
- 登録 repository そのものは `rootPath` を使うこと
- 隔離 repository の空または不正な `registeredRootPath` を拒否すること
- パスを持たない repository を黙って通さないこと

## 残作業

この修正の反映後、初期化済みで滞留している PR
(`Calicula#406` / `Ars#402` / `Interpres#349` / `Ludellus-Native#167`) を再マージする。

別件として残っているもの (本タスクの範囲外):

- `Genius#328` / `Ludellus-Native#113` の
  `git -c failed: Not currently on any branch.` — 隔離リポジトリ側の別バグ
- Cocoiru / Imperativus は登録 checkout が base 以外のブランチにいるため未初期化
