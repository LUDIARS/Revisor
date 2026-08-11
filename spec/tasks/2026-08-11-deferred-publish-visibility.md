---
task: deferred-publish-visibility
project: Revisor
kind: 実装
status: pending
created: 2026-08-11
source_session: lictor-0f2fc185-201a-4e66-9839-cda9c29e43ab
memoria_task_id: null
actio_task_id: null
memory_links:
  - spec/plan/deferred-publish-design.md
  - spec/tasks/2026-08-11-deferred-publish.md
---

# 保留中の publish を UI から見える状態にする

## 目的

`2026-08-11-deferred-publish` で、 GitHub App 未インストール org のマージは
`publication: "deferred"` として記録され、 `refs/revisor/pending-publish/*` に残る
ようになった。 ただし現状これを知る手段は `revisor publish-pending` を実行するか
state を直接読むかしかない。

保留は「後で送る」ことを人間が覚えていないと永久に送られない。 バイパスマージに
`revisor pr bypassed` があるのと同じ理由で、 保留も一覧と盤面から追える必要がある。
設計書 §3 が「UI 対応は最小限でよい」としてスコープ外に置いた分の後追い。

## 完了条件

- Releases / dashboard のいずれかで、 `publication: "deferred"` のマージが
  「GitHub 未送出」と分かる形で出る (件数が 0 のときは何も出ない)
- 保留の理由 (`deferredPublishReason`) と、 後送コマンド (`revisor publish-pending`) が
  その場から辿れる
- 保留が 0 件の環境で表示が増えない (既存ページの見た目を変えない)
- 上記を覆う `test/` の回帰テストがある

## スコープ (編集可ディレクトリ)

- `src/ui-release-page.mjs` ないし `src/ui-dashboard-page.mjs` — 保留の射影と表示
- `src/local-reporter.mjs` — 必要なら盤面向け射影
- `test/` — 回帰テスト

## 対象外

- HTTP マージ経路への `--defer-push` 相当の口。 明示保留は CLI 限定のままとする
  (自動保留は経路を問わず効くので、 GitHub App 未インストール org の実害は既に解けている)。
- 保留分の自動後送 (sweep からの `publish-pending` 実行)。 送出は人間の明示操作に留める。
