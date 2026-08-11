---
task: worker-pool-fast-lane-test-failures
project: Revisor
kind: 実装
status: pending
created: 2026-08-11
source_session: lictor-8327f518-9ed1-44f9-b63e-c709e33160bb
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# fast lane 予約で worker-pool のテスト 2 件が main で落ち続けている

## 目的

`main` (2026-08-11 時点 `fdb8fdc`) の pristine コピーで `node --test test/worker-pool.test.mjs`
を実行すると 4 件中 2 件が失敗する。 レビュー経路のワーカー分配という中核の挙動が、
テストとして緑になっていない状態が続いている。 fast lane の予約枠を standard へ貸さない
既存仕様に、テストの期待値と非決定的な worker 選択を揃える。

Rv #451 (review-diff-scope) の作業中に検出したもので、 その変更より前から落ちている
(`git archive origin/main` の pristine コピーで再現するため、 作業ツリー固有の問題ではない)。

## 現象

### 1. `dispatches one active job per child worker`

- `test/worker-pool.test.mjs:39` で `workerTwo.messages.length` が `1` を期待して `0`。
- `PrReviewWorkerPool` は `size: 2`、 `fastLaneSlots` 未指定。 `fastLaneReservation(2)` が
  1 枠を fast へ予約するため `standardCapacity = 2 - 1 = 1` となり、 2 本目の standard
  ジョブが `#dispatch` の `standardRunning < standardCapacity` を満たさず queue に留まる。
- したがって「ワーカー 1 台につき 1 ジョブを配る」という従来の期待と、 fast lane 予約が
  正面から衝突している。 fast lane の待ちが無い場合も予約枠を standard へ貸さないのが
  既存仕様であり、標準ジョブが 1 本だけ実行される期待値へ直す必要がある。

### 2. `fast work stays within its split capacity instead of borrowing standard slots`

- `test/worker-pool.test.mjs:157` で `TypeError: Cannot read properties of undefined (reading 'id')`。
- `size: 3` / `fastLaneSlots: 1` で fast を 2 本投入し、 1 本目の結果を返した直後に同じ
  worker の `messages[1]` を読んでいるが、 その時点では 2 本目がまだその worker へ配られて
  いない (別の idle worker へ渡ることもある)。 テスト側が配布先を決め打ちしている。

## 完了条件

- `node --test test/worker-pool.test.mjs` が 4 件とも通る
- 1 について、 fast 待ちが無いときも予約枠を standard へ貸さない既存仕様がテストで固定されている
- 2 について、 配布先 worker を決め打ちせず、 実際に配られた worker から `id` を読む形に
  なっている
- `npm test` 全体で本件由来の失敗が無い

## スコープ (編集可ディレクトリ)

- `src/worker-pool.mjs` — `#dispatch` の容量判定
- `src/review-lane.mjs` — `fastLaneReservation` の既定値 (判断次第)
- `test/worker-pool.test.mjs` — 期待値

## 対象外

- `test/workspace.test.mjs` の `the shared git boundary preserves a working LFS clean filter`。
  これも `main` で落ちるが、 原因は実行環境の LFS clean filter であり本件とは別。
