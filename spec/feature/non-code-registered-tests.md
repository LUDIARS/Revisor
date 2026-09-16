---
type: feature
title: 非コード変更の登録検査選択
id: RV-NON-CODE-REGISTERED-TESTS
service: revisor
domain: review-gate
---

# 非コード変更の登録検査選択

AIFormat #1884ではAugur台帳を追加した設定変更が、ドメイン不要と判定された後に
「対象ドメインなし」でテスト選択を停止した。台帳の有無とコードドメインの要否を分ける。

- 審査計画のchangeProfileに分類器のcodeDomainRequiredを保存する。未指定はtrue。
- 台帳があり、対象ドメインが空で、計画が明示的にcodeDomainRequired=falseなら、既存の登録検査計画を実行する。
- 失敗は従来通りブロックし、計画上の省略は理由を残す。新しい合格扱いや全件省略を導入しない。
- コード変更または古い計画で対象ドメインが空なら、引き続き実行不能として止める。
- 対象ドメインがあれば既存のAugur domain bundle経路を維持する。台帳なしの選択も変更しない。
- 通常審査、部分再検証、自動修正後の再計画は同じplanReview経由で分類を引き継ぐ。
- 台帳ありの登録検査は「登録検査（コードドメイン不要）」、対象ドメイン不足は「台帳あり・実行不能」と報告する。
  登録検査の表示は成功を意味しない。各検査のstatusが合否の正本である。

実装はsrc/review-plan.mjs、src/ci.mjs、src/review-report.mjs。
回帰検証はtest/ci-non-code.test.mjs（分類器からの通常/再検証計画、未知計画の拒否、失敗・省略、既知ドメイン経路）。
テスト実行やサービス反映は別途運用規則に従う。
