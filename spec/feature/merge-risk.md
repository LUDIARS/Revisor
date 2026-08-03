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

実行の起点は 2 つ。**審査完了直後の 1 回** (`autoMergeIfEligible`) と、
**60 秒ごとの定期スイープ** (`LocalPrService.sweepAutoMerge`、タイマーは
`startRevisor` が持ち `close` で止める)。完了直後の 1 回だけだと、その瞬間に
base が古かった / 他 PR とコンフリクトしていた PR は条件が解消しても二度と
拾われず、Test OK のまま永久に残る。スイープは見送りを `autoMerge` に記録
しない (毎周期書き換えると `updatedAt` が無意味に churn するため)。

結果は成否とも `autoMerge` (`{attempted, merged, reason, at}`) に残す。人間が
消えると期待した PR が残っている理由を UI が言えるようにするため。自動マージの
失敗が審査ジョブを失敗扱いにすることはない (reporter 内で捕捉する)。

**squash マージは常に直列。** スイープ・完了直後の自動マージ・UI からの手動
マージは互いを知らないので、`LocalPrService.mergePullRequest` が 1 本の
チェーンに載せて 1 件ずつ通す。並走させると同じ `baseSha` から 2 本のコミットを
作り、後の 1 本が compare-and-swap で必ず落ちて、実際にはマージ可能な PR が
失敗記録付きで残る。スイープは 1 周が interval を超えうる (マージ前セキュリティ
スキャンを含むため) ので周回自体も重ねず、候補の判定は周回開始時のスナップ
ショットではなく毎回最新の記録で取り直す。

## マージ拒否の 2 種 (`src/errors.mjs`)

base は審査時の SHA に固定しない。固定すると 1 本マージするたびに残り全部が
マージ不能になるため、進んだ base に対しては squash の適用可否だけを見る。

- `MergeConflictError` — 進んだ base と squash がコンフリクトした。再審査では
  直らずブランチ側の rebase が要るので、`action_required` に落として人間の
  判断待ちにする (Test OK から外れ、テストワークフローの候補からも消える)。
- `StaleReviewError` — 審査済みヘッドと現在ヘッドの差分内容が違う
  (`git patch-id --stable` で比較)。未審査のコードなので `force` 付きで再審査へ
  戻す。比較できない場合 (審査済み SHA が GC 済み等) も同じ扱いで、未知の内容を
  マージしない側に倒す。rebase で SHA だけが変わったヘッドは patch-id が一致
  するので審査結果を引き継ぐ。

どちらも状態そのものが理由を語るので、`autoMerge` に重ねて失敗理由を書かない
(再審査待ちの PR に古い失敗理由が貼りつくのを避けるため)。
