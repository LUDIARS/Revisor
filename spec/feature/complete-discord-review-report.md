---
type: feature
title: "complete-discord-review-report — 完全な審査報告 API"
description: "local PR の詳細と open 一覧に、attempt 単位の reviewReport を公開し、Discord 側が Revisor を開かずに審査開始、各段階、スキップ理由、レビュー本文、結果を表示できるようにする。"
service: revisor
domain: review-report
status: implemented
updated: 2026-09-13
---

# complete-discord-review-report — 完全な審査報告 API

> ### SPEC-COMPLETE-DISCORD-REVIEW-REPORT: attempt 単位の完全レビュー報告

`reviewReport` は `{version:1, attemptId, headSha, entries}` である。entry は安定した
attempt 内 id、kind、label、status、ISO UTC `at`、秘密情報を無害化済みの `content` を持つ。
同じ id は追記せず置換し、retry は同一 head でも別 attempt とする。

審査開始、各段階/検査の開始と完了、再利用または skip の理由、レビューの所見・根拠・結果、
最終完了/失敗を PR レコードへ直ちに書く。`body` は従来どおり PR 本文の正本であり entry に複製しない。
Anatomia の raw graph は載せず、既存の人間向け判定・CI・security 出力だけを保持する。

構造化 content は文字列ごとに秘密情報を伏せてから JSON にする。1 行の JSON 全体を伏せると
1 つの断片で記録全体が読めなくなり、JSON の途中の行を伏せると consumer が人間向けの文章へ
戻せなくなるため。

モデルレビューの本文 (`reviewerOutput`) は、判定に使ったレビュアーの出力を秘密情報の行を伏せて
保存する。`stage:review` の完了記録と最終結果の両方に載せ、通過した審査でも内容を読めるようにする。
モデル名や成功の表示でレビュー内容を代替しない。本文を持たない審査 (レビュー省略・前段で停止) は
null とし、本文保存前の記録にはこの項目が無い (consumer は未取得と表示する)。
再審査は PR レコードの前回本文を消し、モデルレビューを引き継ぐ再検証だけが前回本文を引き継ぐ。
最終結果には引き継いだ審査段階 (`reusedStages`) も載せる。

`reviewedHeadSha` は完走時だけ更新し、古い job/head の報告は現行 attempt を上書きしない。
WebSocket は従来どおり識別子だけを送る無効化 signal とし、consumer は fresh API projection を読む。

## 動作ブロック・体験ブロック

`tests` 段階は Augur のドメイン別 run を動作ブロックとして保持する。各 run は domain、passed、failed、durationMs、runId を日本語の報告に出す。Augur 台帳を持たないリポジトリは「台帳未整備」と出し、全体スイートの通過を Augur の動作証跡に読み替えない。

対象 head の `.augur/runs`（互換の `runs.jsonl` を含む）に evidence 配列があるときだけ体験ブロックを「記録済み」とし、件数を出す。存在しない・空・読めない場合は「未確認」とし、成功表示にしない。完了通知も同じブロックを Concordia へ返す。
