---
type: feature
title: "security-scan — codex-security スキャンの起動と結果の正規化"
description: "codex-security CLI をレビュー用の使い捨て worktree 上で 1 回だけ起動し、終了コードを status に正規化し、保持する finding を severity/rule/file/line だけに削り、レポート成果物を必ず削除する。スキャンごとに専用の state ディレクトリを渡し、並列 worker が共有 SQLite ロックで直列化されないようにする。"
service: revisor
domain: review-gate
tags:
  - security-scan
  - external-model
  - retention
status: implemented
related:
  - ./review-gate.md
  - ../architecture.md
updated: 2026-08-02
---

# security-scan — codex-security スキャンの起動と結果の正規化

`src/security-scan.mjs` が正本。スキャナの起動と結果の正規化だけを担い、
マージ可否の判定は行わない (判定は [review-gate](./review-gate.md))。

## 起動条件と回数

- 設定 `securityScanEnabled` が false のときは CLI を起動せず
  `skipped` (`disabled by settings`) を返す。出力ディレクトリも作らない。
- 審査 1 回につき 1 回 (`runner.mjs` の `reviewSecurityScan`) と、squash merge
  直前に 1 回 (`local-merge.mjs` の `assertMergeSecurityScan`)。
  相互モデル autofix の後には再実行しない — その差分はマージ直前スキャンが覆う。
- スキャナは外部モデルなので、leakage 所見があるとき、および登録テストが失敗
  しているときは起動しない (`skipped`)。流出しうる差分を外部へ出さず、
  既にブロックが確定している差分にスキャン費用も掛けない。

## CLI 引数

`codex-security scan <worktree> --diff <base> --json --effort <設定値>
[--model <設定値>] --auth chatgpt --output-dir <temp>
--fail-on-severity <設定値> --max-cost <設定値>`

`--auth chatgpt` は固定 (neco 決定 2026-07-30)。既定の `auto` は環境に
`OPENAI_API_KEY` / `CODEX_API_KEY` があると従量課金 API へ黙って切り替わるため。
引数は全て Revisor 所有の値 (temp パス・git SHA・列挙で検証済みの severity /
effort・`Number.isFinite` で検証済みのコスト・書式検証済みのモデル名) で、
検証を通っていない外部入力は入らない。

### effort を必ず明示する理由 (2026-07-30)

`codex-security` の `--effort` 既定は **`xhigh`**。 Revisor が渡していなかったため
PR ごとに最高推論で走り、 `--max-cost` を先に食い潰して

```
Scan stopped: estimated cost $X exceeded the $Y limit   → exit 2
```

でスキャンが自己中断していた。 exit 2 は `error` = 「未完了」 に正規化され、
`assertMergeSecurityScan` がマージをブロックする。

対策として `--effort` を設定 (`securityScanEffort`) から**常に明示**し、 既定を
`medium` に下げて「完走すること」を優先する。 深く見たいときだけ設定で上げる。
`securityScanModel` は空なら CLI 既定モデルに任せ、 安いモデルへ寄せたいときだけ指定する。

実測 (2026-07-30、 Revisor 自身の 5 ファイル・+289 行の PR = merge-base 起点の実スコープ):
`--effort medium` で **$4.15**・60 反復で完走した。 ただしこれは
`securityMaxCostUsd` を **$10** に上げた環境での計測で、 既定値は $5 のまま
(このコミットでは変えていない) — つまりこの規模の PR は既定のままだと上限の 8 割強を
使う。 これより大きい PR や `high` へ上げた場合は既定の $5 では自己中断
(exit 2 = 未完了 = マージ不可) しうるので、 深く見たいリポは effort と一緒に
`securityMaxCostUsd` も上げる。 上限額は支出の判断なので既定は人間が決める。

なおスキャン範囲は既に PR 分だけに絞られている (審査時は `worktrees.mergeBase` 起点、
マージ直前は squash commit を作った上で base 起点 = 着地する差分そのもの)。 CLI の
`--path` は `--diff` と**排他** (`--path, --diff, and --working-tree are mutually exclusive`)
なので、 パス指定でさらに絞ることはできない。 コストのレバーは effort / model / 上限額だけ。

不正な effort は `writeSettings` が拒否する (CLI へそのまま渡る値なので、 未知の値で
スキャン自体を落とすと「未完了」= マージ不可になり、 原因が設定であることも見えなくなる)。
`readSettings` は手書き設定ファイル対策として未知の値を既定へ落とす。

### モデル名の書式検証

`securityScanModel` は人間が自由入力する唯一のスキャン引数なので、 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
(または空) だけを許し、 `writeSettings` が拒否・`readSettings` が既定へ落とす。 Windows では
`runNamedCli` が `cmd.exe /d /s /c` 経由で起動し、 cmd.exe がコマンドラインを再解釈するため
`&` / `|` / `>` / `^` を含む値は別コマンドとして走る。 `-` 始まりの値は CLI にフラグとして
読まれ、 `--auth chatgpt` (従量課金を避ける固定) を押しのけうる。

検査は文字列化前に行う。 文字列化してから書式を見ると `null` が `"null"` として
書式検査を通り、 `--model null` で毎回スキャンが落ちて「未完了」= マージ不可になる
(しかも `error` の理由は終了コードだけなので設定が原因だと分からない)。

予算超過そのものは依然 `error` (未完了) として扱う — 部分スキャンを合格として
読ませないため。 effort を下げても完走しない場合は `securityMaxCostUsd` を上げる。

## 環境変数 `CODEX_SECURITY_STATE_DIR`

`scanEnv` がスキャンごとに専用の一時ディレクトリを指す環境を組み立て、
`runSecurityScan` が `execute` (既定は `process.mjs` の `runNamedCli`) の `env`
として渡す。`runNamedCli` の `env` は省略可で、省略時はサービスの環境をそのまま使う
(呼び出し側が 1 変数足すために PATH や ComSpec を組み直さずに済む)。値はサービスの
環境に `CODEX_SECURITY_STATE_DIR` を足したもので、置き換えではない — PATH が無いと
CLI 自体が見つからない。スキャナは既定で全プロセス共通の state ディレクトリ配下の
SQLite にスキャンを登録するため、worker が複数走る Revisor では 2 本目以降が
書き込みロックで `Preparing scan` のまま待たされ、自分のタイムアウトで非ゼロ終了して
PR をブロックする (実測 200 秒超)。

失うのはスキャン履歴とレジューム。どちらも Revisor では参照経路が無い
(レポート成果物は毎回削除し、保持は severity/rule/file/line のみ)。副産物として
共有 state 配下に空の scan ディレクトリが溜まる問題も解消する。

環境に既に別綴りの同名変数 (`Codex_Security_State_Dir` など) があれば取り除いてから
足す。Windows の環境変数は大文字小文字を区別しないため、綴り違いを残すと子プロセスが
どちらを見るか決まらず、共有 state ディレクトリへ黙って戻りうる。

state ディレクトリの作成・削除は `makeStateDir` / `removeStateDir` で差し替えられる
(既定は `mkdtemp` / `rm`)。削除も `finally` で行うが、削除の失敗はスキャン結果を
覆さない (捨てて良い記録しか入っておらず、ここで失敗させると合格した PR が
ブロックされる)。state ディレクトリの作成は `try` の中で行う。出力ディレクトリを
先に作るので、作成に失敗した場合もレポート成果物の削除 (「毎回削除」) を
外さないため。

## 終了コードの正規化

- `0` → `passed`
- `1` → `findings`。閾値以上の finding 件数を数え、`totalFindings` の下限は 1。
  下限に落ちた理由は `reason` で区別する: レポートが読めなかったときは
  `the scan report could not be read`、読めたが閾値以上の finding が無かった
  ときは `the scan report listed no finding at or above the threshold`。
- それ以外 (CLI 不在・未認証・タイムアウト・spawn 失敗を含む) → `error`。
  合格として読ませない。

## severity の順序付け

`critical > high > medium > low`。照合は `Map` で行い、小文字化して比較する。
オブジェクト索引では `severity: "constructor"` が継承メンバへ解決して全閾値と
不一致になり、スキャナがブロックした finding を取りこぼす。順序を付けられない
severity は比較不能なので除外せず数える (スキャナは既にブロックを決めている)。
閾値そのものが未知の場合も全件を数える側に倒す。

## 保持するもの / しないもの

- 保持: `severity` / `rule` (rule→title→name の順に採用) / `file` / `line`。
  文字列は 200 文字で切り詰め、保持件数は 100 件まで。`totalFindings` は
  切り詰め前の件数なので実数を過小報告しない。
- 保持しない: ソース抜粋・再現手順・stderr。`error` の理由は終了コードのみ。
- `--output-dir` のレポート成果物は成功・失敗・例外のいずれでも `finally` で
  削除する。

## 既知の制約: 日本語コミットでスキャンが完走しない (2026-07-31)

`@openai/codex-security` v0.1.4 の同梱 Python プラグインは、`git show -s
--format=%s HEAD` の出力を `subprocess.run(..., text=True)` で encoding 指定
なしに読む。Windows の日本語ロケールでは CP932 デコードになるため、UTF-8 の
日本語コミット subject が `UnicodeDecodeError` を起こす。デコードスレッドが
死んで `completed.stdout` が `None` になり、`git_output` が `.strip()` で
二次クラッシュして exit 2 (incomplete) で終わる。

LUDIARS のコミットメッセージは日本語が常態なので、この状態では**どのリポの
PR もスキャンを完走できない**。exit 2 は「合格として読ませない」規定どおり
ブロックになるため、実質すべての local PR がマージ不能になる。

そのため運用環境の設定ファイルでは `securityScanEnabled` を false にしている
(neco 承認 2026-07-30)。同梱の既定値 (`src/config.mjs` の `defaults()`) は
true のままなので、この無効化は各インストールの設定に閉じる。
再有効化の条件は上流の修正 (`git_command` に `encoding="utf-8",
errors="replace"` が入ること) を確認できること。追跡は Revisor issue #2。

なお `--max-cost` は 1 回のスキャンの費用上限であって、クラッシュ→リトライで
費やす時間の上限ではない。ウォールクロックの安全弁は Revisor 側の
`DEFAULT_TIMEOUT_MS` (30 分) が持つ。
