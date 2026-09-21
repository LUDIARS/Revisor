---
type: feature
title: "complete-discord-review-report — 完全な審査報告 API"
description: "local PR の詳細と open 一覧に、attempt 単位の reviewReport を公開し、Discord 側が Revisor を開かずに審査開始、各段階、登録チェック、スキップ理由、レビュー本文、結果を表示できるようにする。"
service: revisor
domain: review-report
status: implemented
updated: 2026-09-21
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

`reviewReport` 項目をまだ持たない PR レコード (本機能より前に作られたもの) は、進捗記録の
入力として `undefined` を渡す正当な呼び出しである。報告の更新はこれを欠損扱いせず新しい
attempt 報告を作る。契約 C-7 の事前条件も同じ扱いとし、任意の報告が未設定であることを
違反として記録しない。

`reviewedHeadSha` は完走時だけ更新し、古い job/head の報告は現行 attempt を上書きしない。
WebSocket は従来どおり識別子だけを送る無効化 signal とし、consumer は fresh API projection を読む。

## 実行境界で取る進捗

開始時刻はキュー投入時ではなく実行 worker の開始イベントを記録する。投入は `review-queued`、
worker が受け持った時点で `review-start` を書く。段階は `stage:<name>` を queued で置き、
実行開始を `stage:<name>:start`、結果を `stage:<name>:result` と別 id に分ける。同じ id で
上書きすると、落ちた審査の報告で走っていない段階まで走ったように読めるため。

登録チェックの開始・結果は CI の逐次実行ループから IPC で返し、task を所有する worker の
イベントだけを親が受け付ける。結果の確定前に受領済み進捗の永続化を待つ。直接実行時も同じ
callback を使う。Augur の動作ブロックは並行に走り個別の開始時刻を持たないため、返った
結果だけを 1 件ずつ返す。計画が飛ばした検査も結果として返し、報告の沈黙を未実行と取り
違えないようにする。

終局では開始済みで結果が無いものを interrupted、未開始を理由付き skipped として記録する。
既存のゲート・安全な再利用条件は変更しない。security の段階記録は実結果に従い、通過しな
かった skip を通過済みとして引き継がない。

軽量一覧 (`view=summary`) は `reviewReportVersion` だけを返す。カードは詳細の有無しか要らず、
全文は詳細 (`/v1/local-prs/:id`) と `view=full` の一覧が返す。

## 動作ブロック・体験ブロック

`tests` 段階は Augur のドメイン別 run を動作ブロックとして保持する。各 run は domain、passed、failed、durationMs、runId を日本語の報告に出す。Augur 台帳を持たないリポジトリは「台帳未整備」と出し、全体スイートの通過を Augur の動作証跡に読み替えない。

対象 head の `.augur/runs`（互換の `runs.jsonl` を含む）に evidence 配列があるときだけ体験ブロックを「記録済み」とし、件数を出す。存在しない・空・読めない場合は「未確認」とし、成功表示にしない。完了通知も同じブロックを Concordia へ返す。
