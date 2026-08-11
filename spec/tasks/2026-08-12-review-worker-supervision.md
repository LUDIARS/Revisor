---
task: review-worker-supervision
project: Revisor
kind: 実装
created: 2026-08-12
memory_links: []
---

# 審査ワーカーが不在のまま復帰しない

## 目的

審査ワーカーが死んだあと、 誰も起こし直さないまま審査が止まる状態が起きる。 ワーカーの
不在が自力で回復するようにする。

## 背景 (2026-08-12)

`ensureReviewWorker` を呼ぶ契機は 2 つしかない。

- job 投入時 (`PersistentPrReviewQueue`)
- serve 起動時 (`src/server.mjs`)

「サーバの生存に依存する仕掛けは置かない」という設計判断 (server.mjs のコメント) により、
周期タイマーによる起こし直しは意図的に外されている。 その結果、 ワーカーが死んだ後に
新規投入が無ければ、 キューに残った job は誰にも拾われない。

実際に、 走行中の 3 本が失敗した後は `run-worker` プロセスが 0 本になり、 手動で
`node src/cli.mjs run-worker` を起動するまで審査が動かなかった。 現在稼働している
ワーカーはこの手動起動のものなので、 次に死んだら同じ状態に戻る。

失敗した job は `MAX_ATTEMPTS` に達すると `failed` になり、 再投入しない限り戻らない点も
合わせて効いている (投入が無い → 起こされない → 拾われない)。

## 完了条件

- ワーカー不在かつ未処理 job あり、 の状態が続かない。 どこが起こすのかが設計として決まって
  いる (serve の責務にするか、 OS service 側に持たせるか、 投入側で確実にするか)。
- 「サーバの生存に依存する仕掛けを置かない」既存方針との関係が spec に明記されている。
  方針を変えるならその理由も残す。
- ワーカーが 0 本のまま job が滞留している状態を、 外から見て判別できる。

## スコープ (編集可ディレクトリ)

- `src/worker-spawn.mjs` — presence 判定と起動
- `src/persistent-queue.mjs` — 投入時の起こし方
- `src/server.mjs` — 起動時の起こし方
- `spec/feature/daemonless-cli.md` — 方針の明記
