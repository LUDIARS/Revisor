---
task: deployment-changes-binding
project: Revisor
kind: bugfix
created: 2026-09-13
memory_links: []
---

# デプロイ差分APIのGit参照漏れを修正する

## 目的
Concordiaのデプロイ告知が利用するchanges APIの400エラーを解消する。

## 根拠
2026-09-13、Elegantiaの344aeb5f3a68から69df9363a210への差分要求が400、git is not definedを返した。
server.mjsでcollectRepositoryChangesへ渡すgitがimportされていない。

## 作業
既存workspace.mjsのGit実行関数を正しく接続し、実際のHTTPハンドラ経由の回帰ケースを追加する。

## 完了条件
登録済みリポの実コミット範囲をAPIから取得でき、範囲内のPR情報を返す。
差分集約の単体テストだけでなくHTTP境界から参照漏れを検出できる。

## スコープ
src/server.mjs、test/server-repository-changes.test.mjs、spec/tasks/。
