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
updated: 2026-09-03
---

# crash-recovery — 中断されたレビューの復旧

## 1. 問題

当時のレビューキュー (in-process の `PrReviewQueue`; 現在は削除済み) は **in-memory** だが、
PR の `checkStatus` は state ファイル (`revisor.state.json`) に永続化される。
このため Revisor プロセスが job 実行中に落ちる / 再起動すると:

1. state に `checkStatus: "running"` が焼かれたまま残る
2. 新しいプロセスのキューは空なので、その job を実行するワーカーは存在しない
3. `queue.submit` の再投入ガードが `queued` / `running` を弾くため、force 無しでは
   再投入もできない

```js
// 当時の in-process キューの再投入ガード
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

## 4.1 段階ごとのチェックポイント (2026-08-09 neco 指示 / 2026-08-21 拡張)

再投入したレビューを毎回ゼロからやり直すと、**落ちる間隔がレビュー所要時間より短い間は
永久に完了しない**。2026-08-09 の実測では review worker 3 に対して待ち 16 件、
Revisor は 24h で incidents 29 / uptime 62.6%、1 レビュー 20〜30 分だった。
再投入そのものは正しいが、やり直す範囲が広すぎた。

`retryReviewScope()` は以前から model review を飛ばす `verification` モードを返せる。
欠けていたのは**書き込む時点**で、通過の記録は `job.result` から (= job 完走時にだけ)
永続化されていた。途中で落ちると何も残らず、次回は必ず `full` に戻っていた。

そこで **段階が通った直後にその段階のチェックポイントを書く**
(`LocalPrReporter.reviewStageCompleted`)。

### 段階と正本

進捗として記録する段階は 4 つ: `anatomia` / `tests` (登録テスト) / `review`
(モデルレビュー) / `security`。worker の実行ステージ名 (`review-work.mjs`) とは分離し、
初期解析のような内部補助処理は混ぜない。

正本は PR レコードの `reviewStages` (`src/review-stage-progress.mjs`):

```json
"reviewStages": { "review": { "completed": true, "headSha": "<sha>", "at": "<iso>" } }
```

旧 `intentReviewCompleted` は**この記録へ統合した**。同じ意味の状態を 2 箇所に持たない。
この変更より前に書かれたレコードだけ、読み出し時に `intentReviewCompleted` +
`reviewedHeadSha` を `review` 段階の通過として読み替える (書き戻しは新形式のみ)。
`reviewedHeadSha` は意味が違う (マージ時の陳腐化判定が読む「審査を通り切ったヘッド」)
ので残し、完走時にだけ書く。

配線は審査を実行する側 — 短命ワーカー (`runReviewWorker`, `src/worker-command.mjs`) が
`createPrReviewRunner` に `onReviewStageCompleted` を渡す。 サーバは審査を実行しないので
ここには関与しない (SPEC-DAEMONLESS-WORKER-DRAIN)。 落ちるのはこのワーカーであり、
チェックポイントを書く主体と落ちる主体が一致していることが要点。

- `checkStatus` は `running` のままにする。レビューは終わっていない。
  ここで `test_ok` にすると、通っていない段階が通ったように見える。
- 書くのは通過フラグとその段階の成果 (`ci` / `anatomia` / `security` / `reviewer`)
  だけで、判定 (`reasons` / `checkStatus`) には触れない。
- 通ったときだけ書く。失敗した登録テスト、findings のある security、または leakage / tests
  に阻まれて skip された security は通過ではない。plan が security を不要とした skip だけは
  その plan における通過として扱う。
- **worktree がヘッドと一致している間だけ書く。** autofix やレビュアーが worktree を
  書き換えたあとの通過は `headSha` の内容が通ったことにならない。レビュアー呼び出しは
  前後の worktree 指紋を比較し、未 commit の修正があれば review 段階も記録しない。
- チェックポイントの書き込み失敗はレビューを失敗させない。失うのは次回の節約だけ。
  ただし無言にはせず stderr に出す。

### 再投入時の判定

`retryReviewScope()` は現在のヘッドに対して有効な通過段階を求める:

- 段階の `headSha` が現在のヘッドと一致する (rebase で SHA だけ動いた場合は
  `local-pr-service` の `diffPatchId` 指紋判定 `reviewedContentUnchanged` に従う)
- かつ、その段階の**成果がレコードに残っている** (フラグだけ残った段階は再実行する)

`review` が未通過なら従来どおり `full`。通過済みなら `verification` で、
再実行するのは「未通過 / 前回失敗した / 助言 plan を捨てた」決定的段階だけ。
`leakage` は差分から即座に再計算できるので段階に数えず常にやり直す。

validation mode が変わった場合の全段階無効化 (`sameValidationMode`) はそのまま。
設定変更後に古い通過は使い回さない。

引き継いだ段階は `#requeue` が捨てずに残し (`retainedStageProgress` /
`retainedStageProjection`)、head SHA を新しいヘッドへ打ち直す。これが無いと、
次に落ちたときにまた最初からになる。

### 外から見えること

黙って飛ばすと、通っていない段階が通ったように見える事故になる。引き継ぎは 3 か所に残す:

- lifecycle event `review_stage_reuse` (何を引き継ぎ、何を再実行するか、根拠)
- 審査結果 / PR レコードの `reusedStages`
- PR 詳細画面の「引き継いだ審査段階」

## 5. テスト

`test/review-stage-checkpoint.test.mjs`:

- 段階チェックポイントが `reviewStages` とその段階の成果を書き、
  `checkStatus` は `running` のままであること
- 各段階の直後に落ちた PR を再投入すると、通過済み段階が再実行されないこと
- head が変わったら全段階が無効になり `full` に戻ること
- 成果が残っていない段階は通過扱いにしないこと
- validation mode が変わったら引き継がないこと

`test/local-pr-service.test.mjs`:

- `running` で残った PR を再投入し、`force: true` で submit されること
- `queued` で残った PR も同様に再投入されること
- 決着済み (`test_ok` 等) には触らないこと (`scanned === 0`)
- head ブランチ消失時に `failed` + 理由へ落とし、ゾンビを残さないこと

## SPEC-MANUAL-STALLED-REVIEW-RECOVERY: 生存ワーカーが保持する停滞 job の手動復旧

保持プロセスが生存したまま durable job が `running` で停滞した場合は、
CLI の `revisor pr retry <number> --force` だけが古い job を理由付きの
`failed` に終局させ、同じ local PR を新しい job として再投入する。

- 時間しきい値による自動中断はしない。`--force` は人間が停滞を確認した後の明示操作である。
- HTTP / UI の retry 契約に `force` は公開しない。操作範囲は CLI に限定する。
- 古い worker の遅延結果が PR 判定や auto-merge を上書きしないよう、再投入より先に
  PR の `jobId` 所有権を取り消す。job の `completed` / `failed` は終局状態で、遅延した
  worker の settle で別の終局状態へ書き換えない。
- マージで PR が終局する際も `jobId` 所有権を取り消し、残った active job を
  理由付きで終局させる。job の後処理失敗は記録するが、成功済みのマージを失敗扱いにしない。

登録テストは `test/job-store.test.mjs` で終局状態と履歴保持、
`test/local-pr-service.test.mjs` で所有権取り消し・durable 再投入・マージ後処理失敗、
`test/local-pr-commands.test.mjs` と `test/local-contracts.test.mjs` で CLI / HTTP の権限境界を検証する。
