# Opposite-model reviewer の反復失敗（local PR #240 / #247 / #248 / #258）

## 概要

- 発生日: 2026-08-06
- 状態: 作業ツリーで修正済み
- 対象: Revisor の local PR opposite-model review runner
- 重要度: 中（審査を停止し、人手による override 判断を必要とした）

Concordia local PR #240 の登録済みテストが成功した後、opposite-model reviewer が失敗した。Check Run には reviewer の出力が掲載されず、利用者には「Opposite-model reviewer failed; output was withheld from the Check Run.」という通知だけが返された。同日、Concordia local PR #247、Revisor local PR #248、およびこの障害記録を追記した Revisor local PR #258 でも同じ保存エラーと欠落項目を伴う失敗が再発した。

## 事実と影響

- 対象 PR: `LUDIARS/Concordia#240`
- review job ID: `e0918103-db01-4ed0-ba59-48e58f4461ff`
- 更新日時: `2026-08-06T02:33:09.338Z`
- 保存されたエラー: `Opposite-model reviewer failed; output was withheld from the Check Run.`
- 失敗時の状態: `status: failed`、`checkStatus: failed`
- 失敗時の reviewer 情報: `reviewer: null`、`reviewedHeadSha: null`
- 利用者向け通知: `Revisor レビュー失敗: LUDIARS/Concordia#240 は審査を完了できませんでした。`

この PR では、それ以前に Git submodule のローカル URL と `protocol.file.allow` に起因する登録テストのセットアップ失敗があったが、登録テストを再実行して解消済みだった。今回の reviewer 失敗は、そのテストセットアップ問題とは別の review job で発生した。

PR には `humanDecisionMergeable: true` および `humanOverrideMergeable: true` が記録されていた。利用者の明示指示により human-approved merge を行い、merge commit `b74fa8ac4dc44d721ddaefbbc3946f3888b00016` で完了した。

## 再発事例と再審査結果

### `LUDIARS/Concordia#247`

- 失敗時の head SHA: `ef28a829f1e14913d81f14bd6d42d0d39a437503`
- 保存されたエラー: `Opposite-model reviewer failed; output was withheld from the Check Run.`
- 失敗時の状態: `status: open`、`checkStatus: failed`
- 失敗時の reviewer 情報: `reviewer: null`、`reviewedHeadSha: null`
- 2026-08-06 に Codex reviewer で再審査し、`checkStatus: test_ok`、`reviewer: codex-sol` で完了した。
- 再審査済み head SHA: `a32b205c02049cf7c18604cb87c61a1fce394454`
- 登録テスト `submodules`、`vestigium-install`、`vestigium-build`、`install`、`test`、`lint` はすべて成功した。
- 非ブロック所見として orphan 2 件と `coupling_delta` が記録された。

### `LUDIARS/Revisor#248`

- 失敗時の head SHA: `7ccea2b84b9632682570eba20a775fb878a890ec`
- 保存されたエラー: `Opposite-model reviewer failed; output was withheld from the Check Run.`
- 失敗時の状態: `status: open`、`checkStatus: failed`
- 失敗時の reviewer 情報: `reviewer: null`、`reviewedHeadSha: null`
- 2026-08-06 に Codex reviewer で再審査し、`checkStatus: test_ok`、`reviewer: codex-sol` で完了した。
- 再審査済み head SHA: `779150ed2a30ee70ffb3c17c133d9ad9299bb46f`
- 登録テスト `diff-check` は成功した。

### `LUDIARS/Revisor#258`

- 失敗時の head SHA: `81459a150bb9b1db6fea336b467d2ccdd8974cdf`
- 保存されたエラー: `Opposite-model reviewer failed; output was withheld from the Check Run.`
- 失敗時の状態: `status: open`、`checkStatus: failed`
- 失敗時の reviewer 情報: `reviewer: null`、`reviewedHeadSha: null`
- 変更内容は本 problem log の文書更新のみであり、実装コードやテストコードは含まない。
- Codex reviewer での再審査は `checkStatus: test_ok`、`reviewer: codex-sol`、再審査済み head SHA `91a1a9b443b9b9e6aa593ec3eedaef17915692dd` で完了し、登録テスト `diff-check` は成功した。
- 内容審査後に `main` との競合が検出されたため、最新 `main` への rebase と新しい head の再審査が必要になった。

#258 でも失敗したことから、現象は特定リポジトリの実装変更や変更量に限定されず、文書のみの local PR でも発生することが確認できた。

#247、#248、#258 はいずれも Codex reviewer による再審査でエラーが再現せず Test OK となり、変更内容そのものによる決定的な reviewer 失敗ではないことを裏付けた。

## 原因

Claude reviewer のレートリミット。PR #246 の reviewer セッションログには `error: rate_limit`、`apiErrorStatus: 429` が記録されていた。一方、Claude CLI はこの構造化エラーを Revisor が判定していた stdout/stderr に含めなかったため、既存の capacity fallback が発火せず、利用可能な Codex reviewer を試さずに審査全体が失敗した。

#247 と #248 が Codex reviewer による再審査で成功した事実も、Claude reviewer 固有の一時的な capacity failure という特定結果と整合する。

## 改善要件

1. Claude reviewer を Revisor 管理の session ID で起動し、そのセッションの構造化エラーだけを照合する。
2. `rate_limit` / HTTP 429 を capacity failure に分類し、別 provider の reviewer が利用可能なら既存の一回限定 fallback を実行する。
3. reviewer の本文、credential、他セッションのログを Check Run や通知へ漏らさない。
4. 通常の prompt / review failure は capacity fallback の対象にしない。

## 検証方針

- Revisor 管理の Claude session log に `error: rate_limit` / HTTP 429 がある場合だけ capacity failure と判定する unit test を追加する。
- 構造化 rate-limit を既存の alternate reviewer fallback signal に変換することを検証する。
- セッションログが存在しない場合や通常の reviewer failure では従来の判定を維持する。

対象 unit test 9 件を実行し、すべて成功した。サービス再起動・起動テストは local PR のマージ後に Excubitor 経由で行う。

この再発事例追記に対する追加の手動テストは実施していない。#247 と #248 については利用者の明示指示による Revisor 再審査内で、上記の登録テストが実行された。
