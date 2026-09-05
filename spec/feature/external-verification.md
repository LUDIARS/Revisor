---
type: feature
title: "external-verification — Augur による外部テスト保証"
description: "Augur が受理済みテスト実行を Local PR に記録し、現在の head にだけ動作確認の保留を解除する。"
service: revisor
domain: local-pr-lifecycle
status: implemented
related:
  - ./review-gate.md
  - ./merge-risk.md
  - ./pr-lifecycle.md
  - ./human-decision-board.md
updated: 2026-08-23
---

# external-verification — Augur による外部テスト保証

## HTTP 契約

`POST /api/local-prs/:id/verification` は、Augur の受理済みテスト実行を Local PR に
記録する。本文は `source: "augur"`、40 桁の hexadecimal `headSha`、`runId`、
`decision: "accept"`、`by`、ISO 時刻 `at`、非負整数の
`summary: { total, passed, failed, skipped, error }`、
`bundle: { kind, testIds }`、`string | null` の `reportUrl` と最大 2,000 文字の
`note` を持つ。`reject` を含む `accept` 以外の判断と不正な本文は 400 で拒否する。

`summary.contracts: { covered, violated, uncovered }` は省略可。Augur が契約テストの
集計を送るときだけ付き、指定時は 3 つとも非負整数を必須とする。省略した既存クライアント
の呼び出しはそれまでと同じに検証・受理される。

存在しない PR は JSON の
`404 { error: { code: "not_found", message } }` を返す。route 自体が無い場合の既定
404 と本文で区別できるため、Augur は未導入を `not_supported`、未知の PR を
`rejected` と判定できる。PR が open でなければ
`409 { error, status }`、本文の head が現在の head と違えば
`409 { error, headSha }` を返す。成功時は `200 { pullRequest }` を返す。

## 保存する事実

成功した本文へ Revisor の受領時刻 `recordedAt` を加え、PR の
`externalVerification` に保存する。SQLite は PR record 全体を JSON として保持するため
列の追加は要らず、最新 1 件で上書きする。旧 record にこの field が無い場合は
`null` として読む。再審査で head が進んでも記録を削除せず、どの実行が以前の head を
保証していたかを残す。

## 読み取り時の派生

記録はテスト実行と判断の事実だけで、解除済みフラグは保存しない。読取時に head SHA と
照合し、現在なら runtime verification のブロッカーと merge-risk の動作確認要因を解除する。
head が進めば記録を消さずに自然失効し、過去の保証で新しい差分を通さない。これは「人間が
必要かは読むたびに導出する」という Local PR の原則を保ち、設定変更や head 更新を再審査
なしに正しく board へ反映するためである。

`decision.externalVerification` は記録があれば
`{ source, by, at, runId, current }` を返す。`current` は `decision = "accept"` かつ記録の
head と PR の現在 head が一致するときだけ true。現在の記録が効く間は
「人間による動作確認が必要です」を blocker に加えず、merge-risk の
`runtime_verification` 加点を除いて、0 点の `external_verification_cleared` 要因へ
source / by / runId を記す。この差し替えは読取時の `effectiveMergeRisk` だけが行い、
`assessMergeRisk` が保存する要因は審査が見つけた事実のままにする。審査時の事実である
`assessRuntimeVerification` 自体も変えない。
したがって動作確認だけが最後の blocker だった PR は、設定された risk 閾値も満たせば
`auto_ok` と同じ自動マージ述語を満たす。

## UI

board と Test Workflow は `Open / Test OK` の PR に、現在の保証は `Augur 保証 (by …)`、
古い head の記録は灰色の `Augur 保証 (古い head)` として表示する。どちらも保存済み
PR の head と記録だけを、disposition / merge-risk と共通の
`externalVerificationClears` で解釈する。

`summary.contracts` を伴う記録は、board のカードと local PR 詳細に
`covered n / violated n / uncovered n` を表示する。card 側は Augur 保証バッジと同じく
現在の head の記録だけを表示し、古い head の記録は表示しない。`violated > 0` は赤、
`uncovered > 0` (violated が 0) は黄、どちらも 0 なら緑で区別する。`summary.contracts`
のない記録には何も表示しない。この集計は表示のみで、disposition・merge-risk・
auto-merge の判定には使わない。
