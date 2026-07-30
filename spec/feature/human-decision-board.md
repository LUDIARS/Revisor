---
type: feature
title: "human-decision-board — 判断待ちを先頭に出すダッシュボード"
description: "Open な PR を「人間の判断が必要か」で分類・整列して表示し、スマホでも判断だけは完結できるレスポンシブなカード UI を提供する。"
service: revisor
domain: review-ui
tags:
  - dashboard
  - responsive
  - triage
status: implemented
related:
  - ../architecture.md
  - ./merge-risk.md
updated: 2026-07-30
---

# human-decision-board — 判断待ちを先頭に出すダッシュボード

ダッシュボードが答えるべき問いは 1 つ、「このうちどれが自分を待っているか」。

## 判定状態 (`src/pr-disposition.mjs`)

| state | 条件 | 表示 |
|---|---|---|
| `needs_human` | 審査済みだがブロッカーがある / `action_required` | 人間の判断が必要 (bad) |
| `failed` | `checkStatus: failed` | 審査が失敗 (bad) |
| `in_review` | `queued` / `running` | 審査中 (warn) |
| `auto_ok` | 審査通過・ブロッカー無し | 自動マージ可 (ok) |
| `merged` | `status: merged` | マージ済み (idle) |

ブロッカーは draft、マージブロック理由、人間への確認、閾値超過のマージリスク、
必要な動作確認、そしてワーカー失敗時の `error`。すべて文言としてカードに出す。
「なぜ止まっているか」を詳細画面まで潜らないと分からない状態を作らない。

そのためブロッカーは `auto_ok` だけでなく**審査が確定したすべての PR**
(`queued` / `running` / `merged` 以外) で算出する。`needs_human` や `failed` の
カードこそ理由を必要とするので、`test_ok` に限って算出すると理由が空のまま
「人間の判断が必要」とだけ表示されてしまう。

## 並び順

`state` の優先度 → マージリスク降順 → 更新時刻降順。並べ替えはサービス側
(`LocalPrService.listPullRequests`) が行い、クライアントは順序を保つだけ。
判断が必要な 1 件を、緑の 20 件が埋めてしまうのを防ぐのがこの並びの目的。

一覧上部に「判断が必要なものだけ表示」フィルタと件数を置く。

## カード表示

表ではなくカード。同じマークアップが 360px でも読め、デスクトップでは
自動グリッドに広がり、状態バッジが横スクロールなしで見える。

1 枚に載せるもの:

- 状態バッジ (色は tone、色だけに依存せずラベルも出す)
- `repository #番号 タイトル`
- ブランチ・更新時刻・draft
- マージリスクのメーター (0〜100) と `リスク N / 閾値 M`
- チップ: 動作確認の要否、テスト結果 (省略件数を含む)、計画のステージ数
- ブロッカー (最大 4 件、以降は件数表示)
- 自動マージの結果 (実行・見送りとその理由)

カードは `role="button"` + `tabIndex` + Enter/Space で選択でき、選択すると
下の詳細に判断・レビュー計画・テスト・レビュー・差分解析・操作が出る。
すべて `createElement` + `textContent` で組む。値はローカル審査の出力だが、
PR タイトルを HTML 文字列に混ぜればテンプレートインジェクション面になる。

## レスポンシブ

`src/ui-styles.mjs` が正本。デスクトップを先に書き、`max-width: 700px` の
1 ブロックで多カラム構造を畳む。

- カードグリッド → 1 カラム
- `dl.meta` の `max-content 1fr` → 1 カラム
- ナビゲーションは全幅・等分
- 入力とボタンは `font-size: 16px` (iOS Safari のフォーカス時ズーム抑止) と
  `min-height: 44px` (タッチ目標)
- 表は `.table-scroll` に入れて表だけ横スクロールさせ、`body` は横に
  はみ出させない

スマホで完結させたいのは「人間の判断」なので、判断待ちカード・バッジ・
操作ボタンが幅を優先し、生データや表は縮めて後ろに置く。
