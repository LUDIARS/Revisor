---
task: push-guard-global-hooks
project: Revisor
kind: implementation
status: completed
created: 2026-09-12
---
# グローバル hook を保全した push guard と通知更新API

## 目的

環境注入された Git 設定を元 hook と誤認せず、グローバル hook を安全に連鎖する。通知先の変更は hook を再導入せずに行えるようにする。

## 完了条件

- `installPushGuard` は安全なグローバル hook だけを proxy する。
- `revisor repo notify` と loopback API は通知先だけを更新する。
- fixture による hook 解決と通知APIの回帰テストを持つ。
