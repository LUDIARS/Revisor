# Concordia local PR #240 の opposite-model reviewer 失敗

## 概要

- 発生日: 2026-08-06
- 状態: 調査中
- 対象: Revisor の local PR opposite-model review runner
- 重要度: 中（審査を停止し、人手による override 判断を必要とした）

Concordia local PR #240 の登録済みテストが成功した後、opposite-model reviewer が失敗した。Check Run には reviewer の出力が掲載されず、利用者には「Opposite-model reviewer failed; output was withheld from the Check Run.」という通知だけが返された。

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

## 原因

未特定。Check Run と local PR の保持情報には opposite-model 呼び出しの例外分類、provider/model、終了状態、内部相関情報がなく、reviewer 出力も意図的に秘匿されていた。確認できる証拠だけでは、一時的な provider/model 障害、review runner の障害、reviewer 応答契約違反のいずれかを判別できない。

## 改善要件

1. reviewer の本文や秘匿対象出力を Check Run に漏らさず、内部診断用に job ID、対象 head SHA、provider/model、失敗段階、例外分類を保存する。
2. 一時的な provider/model 障害などの再試行可能エラーと、応答契約違反などの決定的エラーを区別する。
3. 再試行は冪等に行い、元の対象 head SHA を保持・検証する。head が変わった場合は同一審査の再試行として扱わない。
4. 利用者向け通知には、秘匿情報を含めずに再試行可否の分類と問い合わせ用の相関 ID を含める。

## 検証方針

- opposite-model 呼び出し失敗を模擬する unit/integration test を追加する。
- 内部には redacted diagnostic と対象 head SHA が保存されることを検証する。
- Check Run と利用者通知には reviewer 本文・例外本文・credential が漏れないことを検証する。
- 再試行可能エラーでは同一 head に対して冪等に再試行され、決定的エラーでは自動再試行されないことを検証する。

この記録追加は文書のみの変更であり、サービス再起動・起動テスト・コードテストは実施していない。
