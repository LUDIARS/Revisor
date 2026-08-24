# 全 Revisor レビューを Codex Sol / medium に固定する

## 背景

運用指示として、Revisor のマージ審査をすべて Codex Sol / medium で実行したい。
既存の `forcedReviewModel` はモデル系列とモデル id を固定できるが、レビュー戦略が選ぶ
effort (`low` / `medium` / `high`) は維持するため、Sol / medium という一つの profile を
全レビューへ適用できない。

## 受け入れ条件

- 設定画面と settings API からレビュー effort を強制指定できる。
- `forcedReviewModel = gpt-5.6-sol` と `forcedReviewEffort = medium` の組み合わせが、
  investigator、judge、test autofix、narrative、plan advisor の全 reviewer stage に適用される。
- 強制指定が空なら従来の review strategy が選んだ effort を維持する。
- 保存済み設定にキーがない環境でも、運用既定として effort は `medium` になる。
- Codex Security の effort 設定は変更しない。
- 不正な effort は保存時に拒否し、壊れた保存値は強制なしとして読む。

## 検証

セッション方針によりローカルテストは実行しない。Revisor の登録済み審査で確認する。
