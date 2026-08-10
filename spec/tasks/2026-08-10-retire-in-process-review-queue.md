---
task: retire-in-process-review-queue
project: Revisor
kind: 実装
created: 2026-08-10
memory_links: []
---
# in-process 審査キュー (PrReviewQueue) を production 面から外す

## 目的

daemonless 化 (`spec/feature/daemonless-cli.md`) で審査キューの正本は `revisor.jobs.json` +
`PersistentPrReviewQueue` になった。`src/queue.mjs` の `PrReviewQueue` はどの production 経路からも
呼ばれておらず、テストが審査を同期実行するための実行体としてのみ残っている。

production から外れたコードがテストの都合で残り続けると、キューの意味論が 2 つあるように読める。
実際 `PrReviewQueue` は in-memory 前提の再投入ガードを持っており、永続キューとは admit の条件が
違う。どちらが正かをコードから読めない状態を解消する。

## 完了条件

- `src/queue.mjs` が production からもテストからも参照されていない (削除されている)。
- 旧 `PrReviewQueue` を使って審査を同期実行していたテストが、`JobStore` +
  ワーカー相当の実行 (またはテスト用の実行体) に置き換わり、同じ回帰条件を検証している。
  - 特に `test/local-pr-service.test.mjs` の supersession 回帰 (追い越された job が現在の審査を
    上書きしない) と、stale 再投入の上限テストが等価に維持されること。
- `test/queue.test.mjs` の検証内容のうち永続キューにも当てはまるもの (同一 head の重複投入、
  force 再投入、settled job の扱い) が `test/job-store.test.mjs` 側に存在する。

## スコープ (編集可ディレクトリ)

- `src/queue.mjs` (削除)
- `src/job-store.mjs`
- `test/`
- `spec/feature/daemonless-cli.md` (「残っているもの」の該当項目を落とす)
