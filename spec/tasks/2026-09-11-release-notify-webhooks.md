---
task: release-notify-webhooks
project: Revisor
kind: 実装
created: 2026-09-11
---

# リリースノート API とリポジトリ単位 webhook 通知

## 目的

登録リポジトリの変更範囲を安全な Markdown と通知文として提供し、Release 作成後と local PR の
merge 後に、リポジトリ単位で設定した Discord / Slack webhook へ best-effort 配送する。

## 完了条件

- C-1 collectRepositoryChanges(repository): 範囲内の commit と merged local PR、Markdown、無害化済み通知文を返す
- C-2 deliverRepositoryNotifications(targets): 有効な Discord / Slack target のみを best-effort 配送する
- C-3 postSlackWebhook(request): Slack URL、本文、3 秒 timeout、mention 無害化の契約を満たす
