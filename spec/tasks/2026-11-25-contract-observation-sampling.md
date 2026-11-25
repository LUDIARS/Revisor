# 契約ログの正常観測を間引く

関連タスクは `actio:6922f8c6-5cb5-4ea7-b038-c15ba27490d1`。

Augur #4242 のランタイムテンプレートを `augur contracts runtime sync` で同期する。
共有ログで記録件数が多かった次の契約は、既存の述語を適用したうえで正常観測を
1% の確率で記録する。違反と述語例外は毎回記録する。

C-12 containsPrivateIp(line): 判定結果を返し、正常観測を 1% の確率で記録する。
C-13 containsLocalPath(line): 判定結果を返し、正常観測を 1% の確率で記録する。
C-27 normalizeForcedReviewModel(value): 正規化結果を返し、正常観測を 1% の確率で記録する。

再注入時の値は `augur.contracts.json` の `sample` で管理する。
既存の注入済みラッパーの設定値も同時に更新する。
