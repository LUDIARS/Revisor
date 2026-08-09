---
task: pr-content-contract
project: Revisor
kind: 実装
status: pending
created: 2026-08-08
source_session: lictor-b500f710-748b-446e-9850-6eb2b4f35293
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# Local PR 内容の検証と表示

## 目的

Cc または Revisor UI から登録される local PR の内容を、日本語の PR タイトル、実装内容、受け入れ条件がそろったものに限定する。内容不足の PR はレビューやテストを開始させない。

## 完了条件

- Revisor API が日本語 title と非空の `## 実装内容` / `## 受け入れ条件` を必須にし、不備ならレビューサービスへ渡す前に reject する。
- Revisor UI の入力欄と詳細画面で Body を `PR内容` として独立表示する。
- API 境界での reject がキュー投入前であり、テスト開始不能であることを回帰テストで示す。

## スコープ

- local PR 提出の検証契約
- Revisor ダッシュボードと PR 詳細表示
- 問題記録
