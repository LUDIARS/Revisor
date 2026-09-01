---
task: registered-test-kinds-rollout
project: Revisor
kind: 雑用
created: 2026-09-01
memory_links:
  - project-revisor-test-review-split
  - feedback-revisor-pitfalls
---
# 登録テストケースに `kinds` / `always` を付けて変更種別で回帰を選別できるようにする

## 目的
AIFormat `RULE_TEST.md` §4 (2026-09-01 新設)「回すテストは変更種別で選ぶ。登録時に必ず
`kinds` を付ける」の実データ側。Revisor の `selectTestCases()` は `kinds` 未指定を
「実行系すべてを担当」に落とすため、76 リポの登録テストケース (Concordia の bootstrap/test/
lint/build 等) がほぼ全て `kinds: null` のままで、docs / spec だけの変更にもフルビルドが走る。

## 完了条件
- `revisor repo list --json` で全登録を取得し、各テストケースに担当種別を付けて
  `revisor repo register --json-file` で再登録する (JSON キーは snake_case:
  `root_path` / `base_ref` / `test_cases`。camelCase は `root_path is invalid` で落ちる)。
  - `git diff --check` 系 → `always: true`
  - lint / typecheck / build / test → `kinds: ["code", "test", "config", "infra"]`
  - docs lint があるリポ → `kinds: ["docs"]`
  - Rust / Tauri / CMake のコールドビルド系 → `kinds: ["code", "infra"]` に限定
- 再登録前後の差分を一覧にして報告する (登録は本ディレクトリのみ、worktree パスを
  `root_path` にしない)。
- spec / ドメイン宣言だけの PR (例: `chore/spec-domains-consolidation` 系) が
  登録テストをスキップして通ることを 1 本で確認する。

## スコープ (編集可ディレクトリ)
- Revisor の登録データのみ (CLI 経由)。ソース変更なし。
- 各リポの `package.json` にテストコマンドを足す必要が出た場合は、そのリポ側の別タスクにする。
