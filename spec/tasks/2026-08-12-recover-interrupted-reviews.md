---
task: recover-interrupted-reviews
project: Revisor
kind: 実装
status: completed
created: 2026-08-12
---
# 中断した local PR 審査の復旧

## 目的

ワーカー停止で job が失われた local PR を、同一 head のまま retry できるようにする。

## 完了条件

- 短命ワーカー起動時に、放棄 job の回収後で local PR の中断審査を復旧する。
- `queued` / `running` の PR でも、未終端 job が無ければ retry できる。
- 未終端 job が実在する PR は従来どおり retry を拒否する。
- 上記の回帰テストを追加する。

## スコープ

- `LocalPrService` の retry ガード
- review worker の起動時復旧
- 関連ユニットテスト
