---
type: feature
title: "review-cost-control — review model cost and retry control"
description: "差分規模とドメイン数に応じたモデル選択、bounded test autofix、同一headの限定再検証、モデルを呼ばない比較検証モードを定義する。"
service: revisor
domain: review-plan
tags:
  - review-planning
  - cost-control
  - retry
status: implemented
related:
  - ../architecture.md
  - ./review-plan.md
  - ../plan/problem_logs/2026-08-05-revisor-review-token-amplification.md
updated: 2026-08-05
---

# Review cost control

## 直近3日ログの検証（2026-08-02〜2026-08-05 JST）

Claude project JSONL を message id で重複排除し、cwd が Revisor の一時 review
worktree に一致するセッションを集計した。

- Revisor: 137 reviewer sessions / 87 unique PRs。すべて `claude-opus-5`。
- cache read 345,972,493、cache creation 12,264,748、output 2,415,636 tokens。
- 全 Claude ログに占める比率は cached tokens 18.3%、output tokens 39.4%。
- Revisor は最大の output-token 区分で、主因の一つ。ただし全 cached tokens の過半ではなく、
  唯一の原因ではない。
- 繰り返し例は Lictor#4 が6回、Revisor#24が5回。再レビュー頻度も独立した増幅要因。
- 同期間の Concordia one-shot 集計で Anatomia は4 calls / 17,848 tokens。
  Revisor reviewer は one-shot 計装外なので provider JSONL が正本になる。

## 実装する抑制

- 差分規模とドメイン数による Sonnet/Terra と Opus/Sol の選択。
- 大規模時だけ2エージェント。調査側は read-only、判断側だけが編集可能。
- review後は一般レビューを繰り返さず、テスト失敗だけを低 effort の限定 prompt で修復。
- 同一headの非レビューrejectは失敗ゲートだけ再実行。
- autofix は3回上限と無変更停止を持つ。無限ループ・同一失敗への課金継続を防ぐ。
- システム/環境ゲートは人間判断で上書き可能にするが、テスト失敗、情報漏えい、実 finding
  は上書きしない。
- 比較測定用の検証モードでは review / Genius / Anatomia domain を `skipped` として記録し、
  残るテスト・漏えい・securityゲートが通ればマージ可能にする。

## 追加の削減候補

1. reviewer / autofix / plan-advisor を Concordia one-shot cost log に計装し、PR番号、目的、
   model、effort、再試行番号を記録する。現状は provider JSONL 解析が必要。
2. `claude-opus-5` を価格表へ追加し、cached/output を実費に換算できるようにする。
3. `planAdvisor=reviewer` はレビュー前に追加モデル呼び出しを作るため、既定 `none` を維持し、
   利用率と採用された計画変更数を計測して価値が低ければ廃止する。
4. 同一 diff patch-id + 同一設定 + 同一 Anatomia version の成功レビューを短期キャッシュする。
   base更新など意味のない差分だけならモデルを再起動しない。
5. prompt の diff 上限に達した大規模PRは、調査担当へファイル別チャンクと機械集計だけを渡し、
   判断担当には調査結果と高リスクhunkを渡す。現在の固定120k文字の重複送信を減らせる。

Concordia の `/v1/cost/one-shots?since=...` は `summary` には since を適用するが `calls` は
直近limitを返すため、期間分析では summary または provider JSONL を使う。
