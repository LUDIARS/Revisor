---
type: feature
title: "early-qa-mode — 審査中から回せる先行QA"
description: "Open PR を審査中 (queued / running) から test workflow に出し、人間の製品確認を自動審査と並行させる。先行QAはマージ条件と reviewed head の意味を緩和しない。"
service: revisor
domain: local-pr-lifecycle
tags:
  - qa
  - test-workflow
  - lifecycle
status: implemented
related:
  - ../architecture.md
  - ./pr-lifecycle.md
  - ./human-decision-board.md
updated: 2026-08-06
---

# early-qa-mode — 審査中から回せる先行QA

## 目的

人間による製品確認と自動審査を直列にせず、ローカルPRの審査中から同じ変更を
確認できるようにする。先行QAは確認開始を早めるだけで、レビューゲート、
マージ条件、登録テストの判定を緩和しない。

## 候補条件

`LocalPrStore.testWorkflowProducts()` はリポジトリごとに、次をすべて満たす最新PRを
1件返す。

- `status === "open"`
- `checkStatus` が `queued`、`running`、`test_ok` のいずれか

`queued` / `running` は `qaMode: "early"` と `Open / In Review`、`test_ok` は
`qaMode: "approved"` と `Open / Test OK` として公開する。`action_required`、`failed`、
`closed`、`merged` は人間へテストを依頼し続けない。

1 件に絞るのは `updatedAt` の新しい順なので、同じリポジトリで後から投稿された PR は
先に `test_ok` になった PR を候補から押し出す。押し出された PR は `Open / Test OK`
のままマージ可能で、判断待ちは board 側に残るが、test workflow からは一時的に
消える。

## SHA契約

- `headSha`: QA対象である現在のPR head。全候補で必須。
- `reviewedHeadSha`: 審査が完了した `test_ok` だけに設定し、審査中は `null`。

利用側は先行QA対象を `headSha` で識別する。`reviewedHeadSha` が無い状態を
審査済みと解釈してはならない。headが変われば、古いQA記録を新しい変更の証拠として
引き継がない。

## ダッシュボード表示

ダッシュボードの「テストワークフロー」パネルは、審査中の先行QAと審査通過後の
確定QAの両方が並ぶ場所であることを説明し、各行に `status` (`Open / In Review` /
`Open / Test OK`) をそのまま出す。UI は `qaMode` を作り直さず、API が返した値を
表示するだけに留める。

## 安全境界

- 先行QAの結果は Revisor の `checkStatus` を変更しない。
- squash merge は従来どおり `Open / Test OK` だけを許可する。
- 旧データに `draft: true` が残っていても、公開・審査・マージの判定には使わない。
- Ccなどの利用側は `Open / In Review` と `Open / Test OK` の両方を受理し、表示上も
  区別する。
