---
type: feature
title: "service-bootstrap — managed listener location resolution"
description: "Excubitor管理起動では集積catalog由来の注入ポートをRevisor自身のlistenerへ適用し、直接CLI起動では中央catalogへfallbackする起動境界。catalogデータの所有や業務domain分類は行わない。"
service: revisor
domain: service-bootstrap
tags:
  - service-startup
  - excubitor
  - port-resolution
status: implemented
related:
  - ../architecture.md
updated: 2026-08-04
---

# service-bootstrap — managed listener location resolution

Revisorのmanaged processを起動する際、listenerの位置はExcubitorが集積したcatalogを
正本とする。Excubitorはbase catalog、per-repository fragment、auto catalogを集積し、
service codeから導出した `<CODE>_PORT` を子process環境へ注入する。Revisorは自分の
service codeに対応する `REVISOR_PORT` を読み、そのポートでのみlistenする。

この責務はcatalog fragmentそのものをapplication domainへ帰属させるものではない。
fragmentは運用設定であり、このdomainが所有するのは、管理processの起動入力を検証して
listenerへ渡すproduction codeの境界だけである。

## 解決順序

1. `REVISOR_PORT` が存在すれば、1..65535の10進整数として検証して採用する。
2. 変数が存在しなければ、直接CLI起動との互換性のため、上位workspaceにある
   `Excubitor/catalog/services.yaml` から従来どおり解決する。
3. 注入値が存在するが不正な場合はfallbackしない。Excubitorとlistenerの認識が違う
   状態で起動成功に見せず、明示的に失敗させる。

この順序により、private serviceの登録を公開base catalogへ重複記載せず、repositoryが
所有するfragmentだけでExcubitorの監視・再起動とRevisorのlisten先が一致する。

`resolveManagedServicePort` がこの順序の正本であり、`cli.mjs` の `serve` だけがRevisor
自身のlistener解決に使う。同居serviceへの接続先 (`resolveServicePort` /
`resolveServiceLoopbackUrl`) は引き続き中央catalogから解決し、このbootstrap責務と混ぜない。
