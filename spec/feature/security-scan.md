---
type: feature
title: "security-scan — codex-security スキャンの起動と結果の正規化"
description: "codex-security CLI をレビュー用の使い捨て worktree 上で 1 回だけ起動し、終了コードを status に正規化し、保持する finding を severity/rule/file/line だけに削り、レポート成果物を必ず削除する。"
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
updated: 2026-07-31
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

`codex-security scan <worktree> --diff <base> --json --auth chatgpt
--output-dir <temp> --fail-on-severity <設定値> --max-cost <設定値>`

`--auth chatgpt` は固定 (neco 決定 2026-07-30)。既定の `auto` は環境に
`OPENAI_API_KEY` / `CODEX_API_KEY` があると従量課金 API へ黙って切り替わるため。
引数は全て Revisor 所有の値 (temp パス・git SHA・列挙で検証済みの severity・
`Number.isFinite` で検証済みのコスト) で、外部入力は入らない。

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
