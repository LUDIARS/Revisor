---
task: worker-stage-visibility
project: Revisor
kind: 実装
created: 2026-08-10
memory_links: []
---
# 審査の実行状況を、サーバが実行しなくなった後も UI に出す

## 目的

daemonless 化でサーバは審査を実行しなくなり、段階ワーカーのプール
(`ReviewStageWorkers`) は短命ワーカーのプロセスが持つようになった。結果として
`GET /v1/review-work` の `workers` は常に空 (`{ queues: [] }`) を返し、Web UI の実行状況パネルが
何も映さない。

「今どの PR のどの段階が走っているか」は、審査が数十分かかる以上、止まっているのか進んでいるのかを
人間が判断する唯一の手がかりになる。空を返し続けるのは、パネルが壊れているのと同じ。

## 完了条件

- ワーカーが自分の段階状態 (queue ごとの configured / idle / running、走行中タスクの stage と対象 PR) を
  外部から読める場所へ書いている (`revisor.jobs.json` と同じ層の記録が自然。プロセス間で読めることが要件)。
- `GET /v1/review-work` の `workers` が、稼働中ワーカーの実際の段階状態を返す。
- ワーカーが 1 つも居ないとき、UI が「実行中のワーカーが居ない」ことと「キューに N 件積まれている」ことを
  区別して表示できる (空の queues と混同しない)。
- ワーカーが異常終了しても、次の `GET` が古い running 状態を現在の実行として見せない
  (pid 生存で判定する。`JobStore.reclaimAbandoned` と同じ根拠を使う)。
- 永続化した worker 状態の読み書き、死んだ pid の状態を除外すること、`GET /v1/review-work` /
  `/api/review-work` の応答、および UI の「ワーカーなし」とキュー滞留の表示を自動テストで検証する。

## スコープ (編集可ディレクトリ)

- `src/worker-command.mjs`
- `src/job-store.mjs`
- `src/server.mjs` / `src/ui-server.mjs`
- `frontend/` 相当の UI (該当パネル)
- `spec/feature/daemonless-cli.md` (「残っているもの」の該当項目を落とす)
