---
task: serve-process-replacement
project: Revisor
kind: 実装
created: 2026-08-12
memory_links: []
---

# serve が繰り返し入れ替わり、審査ワーカー失敗と重なる

## 目的

`src/cli.mjs serve` のプロセスが短い間隔で入れ替わっている。 走行中の審査が
`The review worker died 2 time(s)` で失敗した時期と重なるため、入れ替わりの原因と審査への
影響を特定して止める。

## 観測 (2026-08-12)

リスニングプロセスの起動時刻を追うと、短い間隔で入れ替わっていた。 一方 `/health` は常に
200 を返し、 Excubitor 上も `state: running` / `health_ok: true` のままで、外からは正常にしか
見えない。

同じ時間帯に、無関係な複数 PR が同じ文言で審査失敗した。最後の審査失敗と serve の起動は
同じ秒に記録されていた。

手動で独立起動したワーカー (`node src/cli.mjs run-worker`) は、その後の serve 入れ替わりを
生き延びた。`ensureReviewWorker` は現在 detached process と親に依存しない出力先を使うため、
serve が起動したワーカーについても同じ独立性が保たれることを確認する。

サービス出力には起動バナーが繰り返し記録される一方、該当時刻のエラー出力は無い。終了理由が
記録されていない。

## 完了条件

- serve が入れ替わる契機が特定され、 記録されている (自身の終了 / Excubitor の再起動 /
  外部シグナルのいずれか)。
- 意図しない入れ替わりであれば止まる。 意図した入れ替わり (更新反映等) であれば、
  走行中の審査を道連れにしない形になっている。
- serve の終了が理由付きでログに残る。 現状は「バナーがまた出た」ことからしか分からない。

## スコープ (編集可ディレクトリ)

- `src/cli.mjs` — serve のライフサイクルと終了経路
- `src/server.mjs` — close / shutdown 経路
- `src/worker-spawn.mjs` — 親の生存に依存しない起動 (必要なら)
