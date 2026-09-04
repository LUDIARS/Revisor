---
task: review-stage-flags
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - src/retry-review.mjs
  - src/local-reporter.mjs
  - src/local-pr-service.mjs
---

# 通過したレビュー段階を段階ごとのフラグで保存し、再審査でやり直さない

## 目的

再起動のたびにレビューが最初からやり直しになり、キューが一度も空にならない。

運用観測では、ボトルネックは model review であり、再起動後には中断された審査が
一斉に再投入される。レビューの所要時間がプロセスの安定稼働時間を上回る場合があるため、
途中経過を失うとキューが解消しない。

結果として、`checkStatus` が `running` / `queued` の PR は
`recoverInterruptedReviews()` で毎回再投入され、**毎回ゼロからやり直す**。

## 現状の仕組みと欠けているところ

段階ごとの再開の仕組みは**部分的に既にある**:

- `retry-review.mjs` の `retryReviewScope()` は `intentReviewCompleted` と
  `reviewedHeadSha` を見て、model review を飛ばして deterministic な検証だけを
  やり直す `verification` モードを返せる。
- しかし `local-reporter.mjs` はこれらを **`job.result` から書いている** (L112-114)。
  つまり **job が完走したときにしか永続化されない**。
- 途中でプロセスが落ちると `job.result` が無いので何も残らず、`intentReviewCompleted`
  は false のまま → 次回は必ず `reviewMode: "full"`。

永続化対象とする主要な審査段階は 4 つ: `anatomia` / `tests` (登録テスト) /
`review` (モデルレビュー) / `security`。実装上の worker stage 名とは分離し、
初期解析などの内部補助処理をこの進捗フラグへ混ぜない。**通過した段階の分だけでも進捗が積み上がれば、
落ちながらでもレビューは完了に向かう。**

## 完了条件

- 各段階の完了を、その段階が終わった時点で PR レコードへ永続化する。
  完走時にまとめて書かない。最低でも 4 段階それぞれの完了フラグと、
  **その段階を通したときの head SHA** を持つ。
- 再投入時は、現在の head SHA に対して完了済みの段階を**再実行しない**。
  head SHA が変わっていたらフラグは無効として全段階をやり直す
  (rebase で SHA だけ変わった場合は既存の `diffPatchId` の指紋判定に従う)。
- `intentReviewCompleted` / `reviewedHeadSha` は新しいフラグ集合へ統合するか、
  少なくとも二重管理にしない。**同じ意味の状態を 2 箇所に持たない。**
- 設定 (validation mode) が変わった場合に全段階を無効化する既存の判定
  (`sameValidationMode`) は維持する。設定変更後に古い通過を使い回さない。
- 段階を飛ばしたことが**外から見える**こと。lifecycle か review 結果に
  「どの段階を再利用したか」を残す。黙って飛ばすと、通っていない段階が
  通ったように見える事故になる。
- 回帰テスト: 各段階の直後にプロセスが落ちた状況を模して再投入し、
  完了済み段階が再実行されないこと・head SHA が変わったら全部やり直すことを確認する。

## スコープ (編集可ディレクトリ)

- `src/retry-review.mjs`・`src/local-reporter.mjs`・`src/local-pr-service.mjs`・
  `src/runner.mjs`・`src/worker-pool.mjs`
- `spec/feature/review-plan.md`・`spec/feature/crash-recovery.md`
- `test/`

## Non-goals

- 落ちる原因そのものの修正 (incidents 29/24h)。これは別タスク。
  本タスクは「落ちても進む」ようにするだけで、落ちなくする話ではない。
- review worker 数の変更。同時実行数は claude CLI のコストに直結するので neco 判断。

## 実装 (2026-08-21)

- 正本は `src/review-stage-progress.mjs` の `reviewStages`
  (`anatomia` / `tests` / `review` / `security` の完了フラグと通過ヘッド SHA)。
  旧 `intentReviewCompleted` はここへ統合し、読み出し時の後方互換だけ残した。
- `LocalPrReporter.reviewStageCompleted()` が段階の通過とその成果をその場で書く。
  runner は各段階の直後に呼び、worktree がヘッドと一致している間だけ記録する。
- `retryReviewScope()` は現在のヘッドに対して有効な通過段階を求め、
  未通過 / 前回失敗した段階だけを `verificationTargets` に載せる。
- `#requeue` は引き継ぐ段階の記録と成果を捨てずに残し、lifecycle event
  `review_stage_reuse` と `reusedStages` で引き継ぎを外から見えるようにする。
- 詳細は `spec/feature/crash-recovery.md` §4.1。
