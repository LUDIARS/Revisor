---
task: release-notify-concordia
project: Revisor
kind: 実装
created: 2026-09-12
---

# Concordia への Release 公開通知

## 目的

GitHub Release の作成後、リポジトリ単位で設定した `concordia` target に構造化された
`release-published` イベントを best-effort で配送する。

## 完了条件

- C-2 deliverRepositoryNotifications(targets): 有効な Discord / Slack / Concordia target を best-effort 配送する
- `notify.release` は `concordia` を受理し、`notify.merged` は Concordia へ配送しない。
- manual Release は tag、前回 tag、version、title、notice、URL、公開時刻を配送する。
