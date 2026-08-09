---
task: checkout-publication
project: Revisor
kind: 実装
created: 2026-08-09
memory_links:
  - spec/feature/checkout-publication.md
  - spec/feature/local-workspace.md
---

# マージ済み main を登録 checkout へ fast-forward で降ろす

## 目的

merge は Revisor 所有の merge repository で完結し、登録 checkout は変更されない
(`local-workspace.md`)。この分離により、GitHub publication を通さない運用では
マージ済みの変更がどこへも降りてこない。2026-08-09 に Genius で実測した状態:

- local PR #364 は `status=merged` / `mergeCommitSha=bf1378f5`
- `E:/Document/Ars/Genius` の `main` は `cd190cb` のままで、merge commit object も持たない
- 稼働中サービスは古い dist、次に切る worktree の基点にもマージ分が入らない

設計は `spec/feature/checkout-publication.md` (local PR #388) にある。
本タスクはその実装であり、#388 のマージ後に着手する。

## 完了条件

- merge 永続化直後、同じ `publicationCoordinator` の中で公開処理が走る。
- 実行は設計 §2 の 7 条件をすべて満たしたときだけ。とくに:
  - HEAD が `baseRef` を指しているときのみ (detached・別 branch は対象外)
  - worktree が clean (**untracked file が 1 つでもあれば中止**)
  - `git merge --ff-only` のみ。stash / rebase / reset / force を使わない
  - Cc への照会 (§3) が `allowed`。応答不能・エラーは `allowed:false` として扱う
  - merge commit object は `--no-write-fetch-head` で取得し、ref・設定を変えない
- local PR に `checkoutPublishedAt` / `checkoutPublishError` を追加する
  (`mergeError` とは別。merge は成功しているため)。
- lifecycle event `checkout_published` / `checkout_publish_skipped` を追加し、
  見送りは理由を必ず載せる。`spec/feature/pr-lifecycle-notice.md` のイベント一覧と
  通知テストも同時に更新する。
- 設計 §7 の検証観点をテストで満たす。とくに **dirty の 3 パターンで stash が
  1 件も増えないこと**を明示的に確認する (2026-08-08 に checkout hygiene の stash が
  Concordia の `logs/channel-archives` 585 件を巻き込んだ実害があるため)。

## スコープ (編集可ディレクトリ)

- `src/` (merge / publication 経路と state)
- `spec/feature/checkout-publication.md`・`spec/feature/pr-lifecycle-notice.md`
- `test/`

Cc 側の照会 API と deploy 連携は Concordia のタスク。ここでは呼び出し側だけを作る。
