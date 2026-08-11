---
type: feature
title: "pr-lifecycle-notice — PR ライフサイクルの外向き通知"
description: "session 紐付きの local PR について、発行・審査通過・審査失敗・マージ・取り下げを Concordia の共有『報告』channel へ best-effort で公開する。Concordia が Discord egress を担うため Revisor は webhook/token を持たない。通知内容は PR メタデータと打ち切った理由のみで、差分・テスト出力・leakage 値は含めない。"
service: revisor
domain: pr-notification
tags:
  - notification
  - concordia
  - discord
  - observability
status: implemented
related:
  - ../architecture.md
  - ./crash-recovery.md
updated: 2026-08-11
---

# pr-lifecycle-notice — PR ライフサイクルの外向き通知

## 1. 問題

local PR は Revisor のダッシュボードにしか現れない。 投稿元セッションへの終局通知
(`review-completion-notice.mjs`) は 1 レビュー 1 通で、そのセッションにしか届かない。
運用者が「今どの PR が動いていて、どれが止まっているか」を知るには常時ダッシュボードを
見ている必要があった。

## 2. 責務

このドメインは **PR の状態変化を Revisor の外へ出す経路**だけを持つ。 判定は一切しない
(マージ可否は review-gate、状態遷移は state-machine の責務)。

| 関数 | 責務 |
| --- | --- |
| `pullRequestLifecycleMessage(event, pullRequest)` | state store の公開メタデータから 1 通ぶんの本文を組む。未知 event は `TypeError`。 |
| `notifyPullRequestLifecycle({event, pullRequest, baseUrl, notify})` | session 紐付きの PR だけを `報告` channel へ送る。 |
| `notifyConcordiaChat(...)` | Concordia の `POST /v1/chat` へ 1 行投稿する transport。 |
| `notifyReviewCompletion(...)` | 投稿元セッションへの終局通知 (既存)。 |

## 3. イベント

| event | 発火元 | 意味 |
| --- | --- | --- |
| `created` | `LocalPrService.submitPullRequest` | PR 発行、レビュー受付 |
| `review_passed` | `LocalPrReporter.completed` (conclusion=success) | Open / Test OK |
| `review_queued` | `LocalPrService.retryPullRequest` | 再審査のキュー投入 |
| `review_failed` | `LocalPrReporter.completed` (それ以外) / `.failed` / `#enqueue` 失敗 / 復旧不能 | 理由付きの審査失敗 |
| `merged` | `LocalPrService.mergePullRequest` | squash merge 完了 |
| `bypass_merged` | `LocalPrService.mergePullRequest` (CLI bypass) | 審査を通さない復旧マージ。後追いレビューが必要 |
| `closed` | `LocalPrService.closePullRequest` | マージせず取り下げ。理由の有無とブランチが残ることを明記 |

**審査結果とマージは別イベント。** 自動マージが審査通過の直後に走る場合でも、
`review_passed` を先に出してから `merged` を出す (`completed` は auto-merge の**前**に
審査結果を通知する)。
`review_passed` は Test OK で「テスト開始OK / マージOK」も明示し、
Concordia の TestWorkflow フォーラム側の遷移投稿と同じ可否を伝える。

**同じ状態遷移で 2 通出さない。** 復旧不能な中断レビュー
(`recoverInterruptedReviews`) は、`#enqueue` の失敗通知を `announceFailure: false` で
抑止したうえで、復旧処理自身が最終的な理由 (`Revisor restarted while ...`) で 1 通だけ
出す。 `startRevisor` 側は投稿元セッションへの終局通知だけを担当する。

## 4. session 束縛

Concordia の Discord egress は **session 紐付きの無い chat row を拒否する**ため、
`pullRequest.sessionId` が無い投稿 (CLI / スクリプト) では送信自体を行わず `false` を
返す。 DB 書き込みが受理されたことを Discord 配送と誤って報告しないため。

## 5. 内容の境界

- 含める: repository#number、タイトル (200 字まで)、head → base、マージコミット先頭
  12 文字、失敗理由 (1 件 300 字 × 最大 5 件 + 「ほか N 件」)、取り下げ理由 (300 字)
- 含めない: 差分、テスト出力、leakage の一致値、資格情報、ローカルパス、
  失敗/取り下げ理由内の private endpoint
- 失敗理由と取り下げ理由は資格情報を行単位でマスクする。失敗理由は worker の例外文
  (`git ... failed: <stderr>`、spawn の ENOENT 等) を
  受け取るので、絶対パス (`C:\...` / `/home/...`) はディレクトリ部分を落として末尾の
  名前だけ残す。 ワークステーションのホームディレクトリ名は個人情報で、Discord へ出す
  対象ではないため。 相対パスは診断に要るのでそのまま残す。
- 投稿者が自由に決められる文字列 (タイトル / ブランチ名 / 失敗理由 / 取り下げ理由) は
  埋め込み前に
  正規化する: 空白を 1 文字に畳み、`@everyone` / `@here` / `<@id>` はゼロ幅スペースで
  無害化する。 Revisor の通知が Discord の一斉メンションに使われないため。
- 失敗/取り下げ理由の loopback / RFC 1918 / `.local` URL は
  `[redacted: private endpoint]` に置き換える。公開 URL と相対パスは診断のため残す。

## 6. best-effort

catalog に Concordia が無い / Concordia が落ちている / Discord egress が無効 / 投稿が
拒否された — いずれも PR の受理・審査・マージ・取り下げを変えない。 通知は呼び出し側
(`LocalPrService.#announceLifecycle`, `LocalPrReporter.#announceReviewStatus`) で
必ず catch する。 reporter が throw するとキューは worker 失敗として扱うため、
ここで漏らすと通知障害が審査結果を変えてしまう。

Concordia の場所は Excubitor catalog が正本で、Revisor は Discord の webhook URL や
token を一切保持しない。

## 7. テスト

- `test/pr-lifecycle-notice.test.mjs`: lifecycle 本文と `closed` の warn tone、失敗理由の打ち切り、
  worker error の優先、メンション/改行の無害化、絶対パスの除去 (相対パスは保持)、
  取り下げ理由の資格情報 / private endpoint マスク、`報告` channel への送信、
  session 無しの無送信
- `test/concordia-context.test.mjs`: `POST /v1/chat` の body 形、session 無しで
  transport を呼ばないこと
- `test/local-pr-service.test.mjs`: created → merged / closed の順、復旧不能 PR が
  `review_failed` を 1 通だけ最終理由で出すこと
- `test/review-completion-notice.test.mjs`: `review_passed` → auto-merge → 終局通知の
  順序、action_required と worker 失敗の両方が `review_failed` になること、
  レビュー runner が Concordia 通知を持たない (途中経過で 2 通目を出さない) こと
