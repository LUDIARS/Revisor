---
type: task
title: "審査失敗理由と所見の日本語化"
domain: review-gate
status: in-progress
---

# 審査失敗理由と所見の日本語化

## 目的

Discord に転送される Revisor のブロック理由、所見、人間への確認を日本語で表示する。

## 完了条件

- `C-1 gateOutcome(input): 審査の表示用理由と所見を日本語で返す`
- `C-2 review runner: 人間への確認と複雑度所見を日本語で返す`
- `C-3 decision projection: ブロック理由の補完と人間判断の分類を日本語表示に追随させる`
- 対応する回帰テストが日本語の表示文を検証する
