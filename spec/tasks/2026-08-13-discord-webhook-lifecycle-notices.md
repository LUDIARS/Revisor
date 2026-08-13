# Discord webhook による審査 lifecycle 通知

## 目的

Concordia の提出セッション状態に依存せず、Revisor の審査 lifecycle 通知を
Discord webhook へ直接配送できるようにする。

## 完了条件

- webhook URL を暗号化して保存・照会・削除できる。
- webhook 設定時は lifecycle 通知を直接配送し、未設定時は既存の Concordia 経路を維持する。
- 通知送信は best-effort とし、配送失敗が審査結果を変更しない。
- URL 検証、本文上限、メンション抑制、および設定・配線のテストを追加する。
