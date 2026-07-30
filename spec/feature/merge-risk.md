---
type: feature
title: "merge-risk — マージリスクと動作確認要否のスコア化"
description: "審査結果から「人間が動かして確かめる必要があるか」と「見ずにマージしてよいか」を決定的に採点し、人間が決めた閾値以下をオートマージする。"
service: revisor
domain: merge-risk
tags:
  - risk-score
  - auto-merge
  - runtime-verification
status: implemented
related:
  - ../architecture.md
  - ./review-plan.md
  - ./human-decision-board.md
updated: 2026-07-30
---

# merge-risk — マージリスクと動作確認要否のスコア化

`src/merge-risk.mjs` が正本。どちらのスコアも**決定的**で、加点要因を
すべて列挙する。人間はブラックボックスの数字ではなく内訳を見て反対できる。

## 動作確認要否 (`assessRuntimeVerification`)

「登録テストで足りるか、人間が製品を動かす必要があるか」。

| 要因 | 点 |
|---|---|
| `surface:migration` | 35 |
| `surface:entrypoint` | 30 |
| `surface:ui` | 25 |
| `surface:infra` | 20 |
| 実行コードを含むのに `runtime: true` の登録テストが無い | 20 |
| severity=error のアーキテクチャ違反 | 20 |
| レビュアーが `REVISOR_NEEDS_RUNTIME_CHECK` を報告 | 30 |
| `runtime: true` の登録テストが通過 | −40 (加点合計が上限) |

`score >= 25` で `required: true`。通過した動作テストは差し引くが 0 には
しない。スモークテストが通ったことは migration やリリース入口の安全を
証明しない。

レビュアーには「登録テストで動作を保証できるか」を明示的に問い、できない
場合に `REVISOR_NEEDS_RUNTIME_CHECK` を出させる。差分の意図を読んでいる
唯一の参加者なので、そこに判断を置いている。

## マージリスク (`assessMergeRisk`)

0〜100。バンドは `low` ≤20 / `moderate` ≤45 / `high` ≤75 / `critical`。

| 要因 | 点 |
|---|---|
| 情報流出所見が残る | 100 |
| マージブロック理由がある | 100 |
| 登録テストの失敗 | 40 |
| severity=error のアーキテクチャ違反 | 20/件 (上限 60) |
| error 未満のアーキテクチャ違反 | 4/件 (上限 12) |
| 対象ドメイン欠如 (docs-only を除く) | 20 |
| complexity スコア低下 | 低下幅 (上限 20) |
| 孤立した変更関数 | 4/件 (上限 12) |
| 差分規模 | 150 行ごと +3、5 ファイルごと +2 (上限 18) |
| 変更種別 | infra 14 / config 8 / code 6 / test・asset・generated 2 / docs 0 |
| 動作確認が必要 | 20 (不要でもスコアが残るなら最大 8) |
| 管制プランナーが省略したステージ | 3/件 (上限 9) |
| 所見 (advisory) | 2/件 (上限 6) |

省略ステージを加点するのは、コストと確度のトレードを見えるようにするため。
安く済ませた審査を、全部走らせた審査と同じ緑にしない。

## オートマージ

設定 (`spec/architecture.md` の設定節) は 3 つ。

- `autoMergeEnabled` — 既定 `false`。人間が受け入れるリスクを述べるまで
  自動マージはしない。安全側に仮定できる既定値が無いため。
- `autoMergeRiskThreshold` — 0〜100、既定 15。**これ以下はオートマージ**。
- `autoMergeRequiresRuntimeVerificationClear` — 既定 `true`。
  動作確認が必要な PR は自動マージしない。

判定 (`src/pr-disposition.mjs` / `src/auto-merge.mjs`) は**読み取り時**に
行う。スコアは審査時に保存し、閾値は保存しない。したがって閾値を動かすと
再審査なしに即座に一覧の色と並びとオートマージ対象が変わる。

`auto_ok` 判定とオートマージ実行は同じ述語 (`decidePullRequest`) を共有する。
「自動マージ可」と表示された PR は、実行側が拒否しない PR とちょうど一致する。

実行は審査完了直後に 1 回だけ。結果は成否とも `autoMerge`
(`{attempted, merged, reason, at}`) に残す。人間が消えると期待した PR が
残っている理由を UI が言えるようにするため。自動マージの失敗が審査ジョブを
失敗扱いにすることはない (reporter 内で捕捉する)。
