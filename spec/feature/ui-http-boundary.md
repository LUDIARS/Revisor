---
type: feature
title: "ui-http-boundary — loopback UI の HTTP 境界と許可Host登録"
description: "ローカル UI の HTTP 受口。Host 認可 (loopback + 登録済み許可Host)、UI セッション認可、設定と許可Host の登録エンドポイントを持つ。PR の業務判断は持たず localPrService / queue へ委譲する。許可Host の登録は初期設定の完了を前提にしない独立した境界。"
service: revisor
domain: ui-http-boundary
tags:
  - ui-http
  - host-authorization
  - ui-session
  - allowed-hosts
status: implemented
related:
  - ../architecture.md
  - ./human-decision-board.md
updated: 2026-08-04
---

# ui-http-boundary — loopback UI の HTTP 境界と許可Host登録

`src/ui-server.mjs` が正本。ローカル UI への全リクエストは、この境界で 2 段の認可を
受けてから各責務へ委譲される。マージ可否や PR の状態遷移は持たない。

## Host 認可

1. `Host` ヘッダを `src/host-policy.mjs` の `isAllowedHost` で判定する。loopback
   (`127.0.0.1` / `localhost` / `[::1]`) は常に許可し、それ以外は登録済みの許可Host
   だけを通す。判定に使う許可Host一覧は handler 生成時に復号し、プロセス内に保持する。
2. 許可されない Host は 403 で、ページも API も返さない。

## UI セッション認可

ページ (`/`, `/dashboard`, `/settings`) と `/health` は Host 認可のみで返す。それ以外の
`/api/*` は `x-revisor-session` が起動時セッショントークンと一致することを要求する。
トークンはページの CSP nonce と同じ値で、Cookie ではなくヘッダで送るため、クロス
サイトのフォーム送信からは偽造できない。

## 許可Host登録の独立性

許可Hostの登録は `PUT /api/settings/allowed-hosts` が正本で、初期設定の成立を前提に
しない。`writeSettings` は Anatomia フォルダを必須にするが、リモートから設定を終える
には先に外部 Host を許可する必要があり、両者を同じ境界に置くと設定が始められない。

- この endpoint は UI セッション認可のみを要求し、Anatomia フォルダ・workflow token の
  設定状態を参照しない。
- 保存値は `normalizeAllowedHosts` で正規化し、暗号化 config へ書く。空配列は登録の
  全削除を意味する。
- 保存に成功したときだけプロセス内の許可Host一覧を差し替える。正規化に失敗した要求は
  400 を返し、実行中の許可Hostは変えない。設定変更のために張っている接続を、無効な
  入力ひとつで切らないため。
- 反映は同一プロセス内で即時。再起動を待たずに、登録した Host からアクセスできる。

## 汎用設定 endpoint との分離

`PUT /api/settings` は許可Hostを扱わない。互換のために黙って捨てると、`allowedHosts` を
含む要求へ 200 と現在値を返してしまい、登録されていない Host が登録されたように見える。
`allowedHosts` を含む要求は 400 で拒否し、専用 endpoint を指す。
