---
id: SPEC-RISK-REASSESSMENT
title: 高スコアPRの再審査と通知
type: feature
---

# 高スコアPRの再審査と通知

状態: 実装・検証中。人間の「実装とテストを進める」で開始承認済み。

## 目的
人間が確認する対象を、再レビュー後も高リスクのPRへ絞る。高めのスコアで成立したマージはsystemのメンション通知から追跡できる。

## 変更契約
- 自動マージ設定の閾値を100とする。score >= 100は閾値設定にかかわらず自動マージしない。
- 60 <= score < 100でマージ成立時はsystemへ設定済み管理者の明示メンション付きで通知する。スコア、PR参照、対象head、マージ結果を含める。
- score >= 100は高スコア検出を起点とする一連の処理につき1回、既存のfull review / autofixへ投入し、修正後のheadを再審査する。
- 再審査後もscore >= 100なら人間判断待ちとし、systemへ報告する。再審査ループを禁止する。
- テスト失敗、情報流出、セキュリティ検出、未回答の人間確認など独立したマージ阻止条件は維持する。
- headが変わった場合は旧headの判定を新headへ流用しない。スコア不明を低リスクとして扱わない。
- 再審査の予約・対象head・job・通知状態はPRの永続記録に残す。プロセス再起動や並行ワーカーでも重複実行を防ぐ。
- 配送失敗はマージ失敗として扱わず通知未達として残す。API受付と配送確認を区別する。
- 人間の回答「自動修正も含める」を反映する。既存reviewerの指摘修正とRv所有のcommit・検証処理を再利用する。修正でheadが進んでも同じ処理の回数をリセットしない。再審査後100以上、修正不能、途中失敗は人間へ報告し、成功とみなさない。

## 対象境界
純粋な判定: auto-merge.mjs / pr-disposition.mjs と新しい再審査判定モジュール。
手順と永続状態: local-pr-service.mjs / state-store.mjs / review queue。
外部通知: review-context.mjs / concordia-context.mjs / 専用スコア通知モジュール。
設定と表示: config.mjs / ui-settings-page.mjs。
既存のreviewMode引き継ぎは高スコア再審査に適用しない。

## 受入条件
59/60/99/100の境界。設定100で100点がマージされないこと。
高スコアの1回目はfull reviewと指摘修正、修正後再審査でも100以上なら人間報告。同時呼出し・再起動・autofixによるhead更新でも追加投入しない。
再審査で99以下になれば既存の全マージ条件を再評価する。
head変更、レビュー失敗、通知失敗、メンション先未設定を明示的に扱う。
通知対象はCc管理者設定から解決し、PRタイトル等に埋め込まれたメンションは許可しない。

## 調査根拠
現行merge-risk.mjsの算出値は0〜100にclampされる。
現行pr-disposition.mjsはscore > thresholdを阻止するため、設定値だけ100にする変更は不十分。
既存ライフサイクル通知は報告channel / webhook向けで、systemメンション配送を別途接続する必要がある。

## 検証状態
Rvの関連84テストと実Git再投入経路2テスト、Cc通知関連23テストと型検査が成功。既存retry-review-content-matchの1件失敗は本体mainでも再現。広い実Git回帰は遅延とfixture削除EPERMのため中断し、全件成功とは扱わない。実稼働設定は未変更。再起動・マージは未実施。

## 復旧と移行
Ccのmention_admin受付・配送を先に反映してからRvを反映し、実設定の閾値を100へ変更する。旧Rvへの設定100適用は100点をマージ対象にするため先行しない。通知受付は配送完了ではない。unknown通知はCc記録を照合してから手動再送する。自動修正の予約後に停止した場合は結果不明として追加修正を自動起動しない。修正回数はPR単位で保持し、外部head更新による自動リセットもしない。人間は既存の明示再審査・マージ操作から復旧できる。

提出依存: Concordia local PR #2022（commit ebc88d2）のmention_admin API。RvのAnatomia差分検査はrule_conformance/duplication/coupling_delta/convention_drift成功、spec_linkage警告が残る。仕様IDと実装注釈は追加済み。実Git検証は成功したがWindowsのfixture後始末でEPERMが出たため一時fixtureが残った。liveサービス再起動・本番設定変更・実メンション配送は未実施。
