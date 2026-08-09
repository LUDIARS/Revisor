---
task: restart-requeue-backlog
project: Revisor
kind: 実装
created: 2026-08-09
memory_links: []
---

# 再起動のたびにレビュー滞留が積み上がる

## 目的

2026-08-09 の実測:

- Excubitor 報告: 24 時間で **22 インシデント / 稼働率 0.657**
- 起動時ログ: `Revisor recovered interrupted reviews: scanned=17 requeued=17 failed=0`
  (別の起動では `scanned=14 requeued=14`)
- `GET /v1/review-work` 時点のキュー:

| キュー | 同時実行 | 待ち |
|---|---|---|
| review | 3 | **18** |
| anatomia / tests / security | 0 | 0 |

ジョブ 25 件のうち **17 件が 86〜87 分前**に積まれており、これは最後の再起動で
requeue された分と一致する。87 分間で完了したのは 4 件のみ。

再起動 → 中断レビューを requeue → 滞留が増える、を繰り返しており、
新規 PR は数時間待たされる。今回 Anatomia #390 は投入 51 分後の時点で
まだ着手されていなかった。

加えて、**外側の `reviewQueue` は 21 件すべてを `running` と報告する**が、
worker 層では `running=3 / queued=18` である。PR の `checkStatus` が `running` でも
実際には未着手のことがあり、Cc / Discord / UI の「審査中」表示が実態と食い違う。

## 完了条件

- 再起動の原因を特定する。まず「なぜ落ちるのか」であって、requeue の作り込みではない。
  クラッシュなのか Excubitor の restart-policy によるものなのかを切り分ける。
- 再起動後の requeue が**滞留を単調増加させない**こと。同一 PR の重複ジョブや、
  実体を失ったジョブが残り続けないこと。
- `reviewQueue` の `status` が worker 層の実態 (running / queued) を反映すること。
  少なくとも「未着手」と「実行中」を呼び出し側が区別できるようにする。
- 併せて、`checkStatus: running` の PR が待ち行列のどこにいるかを外から見えるようにする。

## スコープ (編集可ディレクトリ)

- `src/`
- `spec/`
