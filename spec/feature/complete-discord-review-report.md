---
type: feature
title: "complete-discord-review-report — 完全な審査報告 API"
description: "local PR の詳細と open 一覧に、attempt 単位の reviewReport を公開し、Discord 側が Revisor を開かずに審査開始、各段階、スキップ理由、結果を表示できるようにする。"
service: revisor
domain: review-report
status: implemented
updated: 2026-09-12
---

# complete-discord-review-report — 完全な審査報告 API

> ### SPEC-COMPLETE-DISCORD-REVIEW-REPORT: attempt 単位の完全レビュー報告

`reviewReport` は `{version:1, attemptId, headSha, entries}` である。entry は安定した
attempt 内 id、kind、label、status、ISO UTC `at`、秘密情報を無害化済みの `content` を持つ。
同じ id は追記せず置換し、retry は同一 head でも別 attempt とする。

審査開始、各段階/検査の開始と完了、再利用または skip の理由、レビューの所見・根拠・結果、
最終完了/失敗を PR レコードへ直ちに書く。`body` は従来どおり PR 本文の正本であり entry に複製しない。
Anatomia の raw graph は載せず、既存の人間向け判定・CI・security 出力だけを保持する。

`reviewedHeadSha` は完走時だけ更新し、古い job/head の報告は現行 attempt を上書きしない。
WebSocket は従来どおり識別子だけを送る無効化 signal とし、consumer は fresh API projection を読む。
