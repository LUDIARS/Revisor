# Revisor review token amplification

## 症状

同一PRがreview/autofix後のテスト失敗や再審査で繰り返しreviewerを起動し、すべて
Opusへ解決されていた。直近3日で87 PRに137 sessions、output 2,415,636 tokensを消費した。

## 原因

- persisted reviewer id が規模に関係なく強いモデルへ固定されていた。
- autofix後にAnatomiaと一般レビューを再実行する経路があった。
- retryはreject元を区別せず、全レビューを再投入した。
- scannerやAnatomiaの環境失敗も人間が上書きできず、同じ審査を繰り返しやすかった。

## 対応

- X/Y閾値によるモデル/effort選択と、大規模差分だけの調査・判断分業。
- reviewは1回、以後は失敗テストだけのbounded autofix。一般レビューは再実行しない。
- 同一headの非レビューrejectは失敗ゲートだけを再審査。
- system/environment blockerには明示的な人間判断mergeを追加。実 finding は対象外。
- 空diffと登録base不一致をモデル起動前に拒否する。

## 再発防止

レビュー戦略をPRのreview planへ保存し、選択理由、コード変更行数、編集ドメイン数をUI/API
から追跡可能にする。provider別コスト計装は `review-cost-control.md` の追加候補として追跡する。

## 2026-08-05 local PR #227 reviewer failure

Claude reviewer はコード解析前に HTTP 429 `monthly spend limit` で終了した。相互provider固定では
一方の月額枠切れが全PRを停止するため、capacity / rate limit / quota系だけ同じtier/effortの
反対familyへ1回フォールバックする。通常のreview failureはフォールバック対象にしない。
