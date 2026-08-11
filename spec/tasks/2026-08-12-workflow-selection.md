---
task: workflow-selection
project: Revisor
kind: 実装
created: 2026-08-12
memory_links:
  - spec/plan/workflow-selection-design.md
  - spec/plan/deferred-publish-design.md
---

# リポジトリ別の公開ワークフロー選択 (GitHub Workflow / Revisor Workflow)

## 目的

`spec/plan/workflow-selection-design.md` の実装。 org ごとに公開経路が違う —
LUDIARS は GitHub App + Release 管理 (現行の Revisor Workflow)、 MELPOT は全 private で
通常 push が通り App を入れる理由が無い。 publisher が一本 (App 前提) のため、 後者は
`GET /repos/.../installation → 404` で保留 (deferred) に落ちるしかない。

どちらの経路で送るかを登録リポジトリの属性として持たせ、 App を使わない plain push の
公開経路を追加する。 既定 (`revisor`) の挙動は 1 bit も変えない。

## 完了条件

- 登録リポジトリに `workflow: "revisor" | "github"` を持つ。 `repo register` の JSON 本文で
  指定でき、 `repo set-workflow <owner/name> <revisor|github>` で後から変更できる。
  `repo list` に workflow 列が出る。
- 優先順が **リポ個別指定 > org 既定 (`REVISOR_ORG_WORKFLOWS`) > グローバル既定 `revisor`**。
  org 既定の誤記は既定へフォールバックせず設定エラーとして投げる (黙って `revisor` へ戻ると
  公開が理由の見えないまま保留され続けるため)。
- `workflow = "github"` の publish が GitHub App を組み立てず、 remote tags 照会も
  Release 作成も行わず、 マージコミット (とリリースタグ) を fast-forward push する。
- その push の失敗はローカルマージを巻き戻さず保留へ落ち、 `publish-pending` が同じ経路で
  再試行して解消する。
- `.revisor-version` ゲート・審査ゲート・セキュリティスキャン・タグ選定は両経路で共通のまま。
- 設計書 §2 のテスト 1〜5 が green。 既存の deferred-publish 5/5・local-merge 18/18 も green。

## スコープ (編集可ディレクトリ)

- `src/` — `repository-workflow.mjs` / `plain-git-publication.mjs` /
  `github-workflow-publication.mjs` (新規)、 `release-publisher.mjs` /
  `local-contracts.mjs` / `state-store.mjs` / `local-pr-commands.mjs` / `cli.mjs`
- `test/` — `repository-workflow.test.mjs`
- `spec/feature/daemonless-cli.md`

## 禁止

リモート送信 / PR 作成 / 既存 revisor workflow の挙動変更 / ゲート・審査ロジック変更。
