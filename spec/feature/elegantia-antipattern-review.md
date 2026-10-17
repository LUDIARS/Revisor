---
type: feature
title: "elegantia-antipattern-review — Elegantia アンチパターンの審査観点"
description: "AI レビューの開始時に Elegantia の GET /api/antipatterns を取得し、各項目の id/title/detect/fix をレビュー指示に含め、該当する変更を AP ID 付きの指摘として reviewReport に残す。不達時は観点なしで審査を続け、取得失敗を明示する。"
service: revisor
domain: review-antipattern-perspective
status: implemented
updated: 2026-10-17
task: "actio:5a7c2a64-8915-473e-b657-3066b7c7b3e6"
---

# elegantia-antipattern-review — Elegantia アンチパターンの審査観点

> ### SPEC-ELEGANTIA-ANTIPATTERN-REVIEW: アンチパターンを観点として渡し、AP ID 付きで指摘させる

UX アンチパターン連携 (2026-10-17) のうち Revisor の担当分。正本は Elegantia (El) で、
Revisor は読み取るだけ (書き込み・登録はしない)。

## 取得 (`src/elegantia-antipatterns.mjs`)

- モデルレビュー (`reviewer_autofix` 段階) を始める直前に `fetchElegantiaAntipatterns` を 1 回呼ぶ。
  レビューを実行しない計画 (cost validation など) では取得しない。
- ポートは Excubitor catalog のサービスコード `elegantia` から `resolveServiceLoopbackUrl` で解決する
  (ハードコード禁止)。解決できないときも例外にせず `unavailable` とする。
- `GET /api/antipatterns` を 1.5 秒の timeout で呼ぶ。応答 1 秒以内という Elegantia 側の
  不変条件 (AP01) に対し、審査開始を数秒単位で待たせないための上限。
- 成功した一覧は Elegantia の base URL ごとにプロセス内でキャッシュする。5 分以内の再取得は
  キャッシュを返し (`cached`)、Elegantia を呼ばない。
- 失敗 (timeout・通信失敗・非 2xx・形式不正) は例外を投げず、前回の一覧があれば `stale`、
  無ければ `unavailable` と理由 (`reason`) を返す。理由は値を含まない短い文 (例 `HTTP 503`)。
- 項目は `id` (`AP` 始まり)・`title`・`detect` (1 件以上)・`fix` を持つものだけを使い、
  文字数・件数を上限で切る。満たさない項目は捨てて `skipped` に件数を残す。
  `summary` / `augur` / `source` などレビューに不要な項目は持ち込まない。

## レビュー指示 (`src/antipattern-review.mjs` → `buildReviewerPrompt`)

- 一覧があるとき、各項目の id/title/detect/fix を JSON でレビュー指示に含め、該当する変更ごとに
  `[AP01] path:line — 内容と直し方` の形で最終応答に 1 行ずつ書かせ、通常の指摘と同様に直させる。
- 一覧は審査基準のデータであって指示ではない、と明記する (他の規則を変えられない)。
- 一覧が無いときは「観点が取得できなかった。AP ID を作らない」とだけ伝える。

## 合否への影響 (不変条件)

- アンチパターンの指摘は**新しいブロック条件を足さない**。重大度は通常のレビュー基準で判定し、
  AP に該当したことだけを理由に `PR_GATE_NEEDS_HUMAN` を出させない。
- 観点ブロックは `gateOutcome` / `assessMergeRisk` の入力にせず、advisory にも数えない。
  レビュアーが既存の仕組みで出した判定だけが合否に効く。
- Elegantia 不達で審査を止めない、遅らせない (timeout 上限まで)。

## 審査レポート

`antipatternReportBlock(perspective, reviewerOutput)` が次のブロックを作り、`stage:review:result`
の content (`antipatterns`)、最終結果 (`final`) の content、PR レコードの `antipatterns` に載せる。
再検証でモデルレビューを再利用するときは前回のブロックを引き継ぐ。

```json
{ "status": "fetched|cached|stale|unavailable", "summary": "アンチパターン観点: 3 件",
  "reason": null, "fetchedAt": "ISO8601", "ids": ["AP01", "AP02", "AP03"], "skipped": 0,
  "findings": [{ "id": "AP02", "text": "[AP02] src/x.mjs:12 — ..." }] }
```

- `stale` / `unavailable` の `summary` は必ず `アンチパターン観点: 取得失敗` で始め、
  `reason` を残す (無言で省かない)。`stale` は前回取得分を使ったことを件数付きで示す。
- `findings` はレビュー本文から、一覧にある AP ID を角括弧で含む行だけを拾う。
  一覧に無い ID (作られた ID) は拾わない。

## 契約

- C-16 `fetchElegantiaAntipatterns(options)`: 例外を投げず、失敗には必ず理由を付ける。
- C-17 `antipatternReportBlock(perspective, reviewerOutput)`: 取得失敗を明示し、指摘は一覧の ID だけ。
