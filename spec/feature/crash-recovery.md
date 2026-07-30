---
type: feature
title: "crash-recovery — 中断されたレビューの復旧"
description: "Revisor プロセスが job 実行中に落ちると、その local PR は queued / running のまま永久に残る (キューは in-memory、再投入ガードも force 無しでは弾く)。起動時にこの 2 状態を中断済みと判定して拾い直し、復旧できないものは理由付きで failed に落とす。"
service: revisor
domain: state-machine
tags:
  - crash-recovery
  - queue
  - startup
status: implemented
related:
  - ../architecture.md
  - ./review-gate.md
updated: 2026-07-30
---

# crash-recovery — 中断されたレビューの復旧

## 1. 問題

レビューキュー (`src/queue.mjs`) は **in-memory** (`#pending` / `#running`) だが、
PR の `checkStatus` は state ファイル (`revisor.state.json`) に永続化される。
このため Revisor プロセスが job 実行中に落ちる / 再起動すると:

1. state に `checkStatus: "running"` が焼かれたまま残る
2. 新しいプロセスのキューは空なので、その job を実行するワーカーは存在しない
3. `queue.submit` の再投入ガードが `queued` / `running` を弾くため、force 無しでは
   再投入もできない

```js
// src/queue.mjs
if (!force || existing.status === "queued" || existing.status === "running") {
```

結果、その PR は**自然回復しないゾンビ**になる。実測で 46 時間 `running` のまま
`ci` が空という PR が残り、それが他の PR のブロッカー解除 PR だったため
「解錠する側の PR がゾンビで動かない」という循環まで起きた。

## 2. 判定 — 時間しきい値を使わない

起動直後は in-memory キューが**必ず空**なので、その時点で `queued` / `running` が
残っている open PR は、定義上どのワーカーにも属していない。よって

> 起動時の `status === "open"` かつ `checkStatus ∈ {queued, running}` = 中断された

が曖昧さなく成立する。 「N 分以上更新が無ければ stale」のような時間しきい値は不要で、
使うべきでない (長い CI を誤って中断扱いにする)。

## 3. 復旧処理

`LocalPrService.recoverInterruptedReviews()` が対象を列挙し、1 件ずつ
`retryPullRequest` と同じ経路 (`#requeue`) に流す:

- head / base の ref を**再解決**する (落ちている間にブランチが進んでいる可能性がある)
- 前回のレビュー投影を `pendingReviewProjection()` で捨てる
- `checkStatus: "queued"` + `error: null` にして `{ force: true }` で再投入
  (force が無いと同一 head の settled job に解決されてしまう)

**1 件の失敗で起動全体を落とさない。** repo 未登録 / head ブランチ消失などで復旧できない
PR は、ゾンビのまま残さず必ず終端状態へ落とす:

```
checkStatus: "failed"
error: "Revisor restarted while this review was in flight and it could not be resumed: <理由>"
```

戻り値は `{ scanned, recovered[], failed[] }`。

## 4. 呼び出し位置

`startRevisor` (`src/server.mjs`) の **`server.listen` 成功後**。 git の ref 解決が遅い
リポジトリがあってもポートの開通を遅らせないため。 `scanned > 0` のときだけ
stdout に要約を、復旧不能分は stderr に 1 行ずつ出す。 結果は `startRevisor` の戻り値の
`recovery` にも載せる (テスト・運用確認用)。

呼び出し自体が例外になった場合 (state 読み取り不能など) は、 listen 済みのサーバと
ワーカープールを閉じてから投げ直す。 起動に失敗しながらポートとワーカープロセスだけ
残る状態を作らない — アドレス解決失敗と同じ後始末の規約に合わせる。

## 5. テスト

`test/local-pr-service.test.mjs`:

- `running` で残った PR を再投入し、`force: true` で submit されること
- `queued` で残った PR も同様に再投入されること
- 決着済み (`test_ok` 等) には触らないこと (`scanned === 0`)
- head ブランチ消失時に `failed` + 理由へ落とし、ゾンビを残さないこと
