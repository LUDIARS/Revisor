---
task: "local-pr-list-without-review-report"
project: "revisor"
kind: "実装"
created: "2026-10-02"
actio: "actio:273dc1ee-5e9c-450f-b6c2-e4991b3fda05"
---
# local PR 一覧から審査レポート本文を外す

## 目的

`GET /v1/local-prs` (view=full) の応答の大半を `reviewReport` 本文が占め、一覧取得が
Concordia の Revisor クライアントのタイムアウトを超えていた。一覧からは本文を外して版
(`reviewReportVersion`) だけを返し、本文は PR 単位の詳細 GET から取る。

## 分解

- [x] `src/pr-list-cache.mjs`: `fullProjection` を追加し、`listResponseBody` が既定で本文を外す。
      `include=reviewReport` を `parseListIncludes` で解釈する (未知の値は 400)。
- [x] `src/server.mjs` / `src/ui-server.mjs`: 一覧ルートで include を検証し、応答キャッシュの
      キーに include を含める。
- [x] 詳細 GET (`/v1/local-prs/:id`, `/api/local-prs/:id`) は従来どおり本文を返す (変更なし)。
- [x] CLI `pr show` / `pr list --json` は store を直接読むため変更なし。
- [x] 契約 C-11 (`listResponseBody`) を追加。
- [x] テスト: `test/pr-list-cache.test.mjs`、`test/server.test.mjs`、
      `test/ui-server-allowed-hosts.test.mjs`。
- [x] spec: `spec/feature/complete-discord-review-report.md`。

## 受け入れ条件との対応

- C-1 一覧から本文が消える → C-11 / `drops review report bodies from the full list ...`
- C-2 PR 単位で本文が取れる → `serves review report bodies per PR instead of in the full list`
- C-3 summary・state は不変 → 既存テスト + C-11
- C-4 Revisor 内の利用者が壊れない → Revisor 内で一覧の `reviewReport` を読む箇所は無い
  (Web UI・test-workflow・通知は store / 詳細を読む)。
