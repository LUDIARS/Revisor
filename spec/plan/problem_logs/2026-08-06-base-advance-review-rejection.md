# base 前進時に local PR の審査開始が拒否される

- Date: 2026-08-06
- Status: fixed in working tree
- Area: local PR review workspace preparation
- Severity: medium（競合のない local PR が審査前に失敗する）

## Summary

Revisor local PR #246 は、提出後に `main` が前進しただけで `failed` になった。「競合がなければ進んだ base にマージ可能」とした workflow 改善後も、審査開始前の古い SHA 完全一致ゲートが残っていた回帰である。

## Evidence

- PR: `LUDIARS/Revisor#246`
- job ID: `565e3285-5cec-4fed-b3f9-1dbb37e616ad`
- 更新日時: `2026-08-06T02:49:48.085Z`
- エラー: `base SHA changed before review (expected 0ac4a811ebd64e302b22f9a90a521ac16e484673, found 3ab61d48adfb34528c0863c3de8cbcea5f39de3c)`
- 発生箇所: `src/workspace.mjs` の `prepareLocalWorktrees()`

## Regression Context

commit `473b9270f3fda648d1dba5ed8b55c7c56b99680f` は、base/head の SHA 完全一致ゲートを撤廃し、進んだ base に squash がクリーンに適用できる限りマージを許可する仕様を導入した。しかし `src/local-merge.mjs` のマージ時ゲートだけが撤廃され、review workspace 準備時の base SHA ゲートは残った。

## Cause

`prepareLocalWorktrees()` が、提出時の `request.baseSha` と審査開始時の `inspected.baseSha` の完全一致を要求していた。審査対象 head SHA は変わっていないため、base の前進だけで審査を拒否する必要はない。

## Fix Requirements

- 審査対象の head SHA 一致検証は維持する。
- base SHA が前進していても review workspace を準備する。
- 実際のマージ時は現在 base への squash 適用を行い、競合時だけ `action_required` にする既存挙動を維持する。

## Verification

- 提出時 base SHA を保持したまま `main` を別ファイルの commit で前進させ、`prepareLocalWorktrees()` が成功する回帰テストを追加した。
- Revisor local PR の登録テストで全体検証する。

## Follow-up

修正を含む local PR を再提出し、base 前進だけでは審査が失敗しないことを確認する。
