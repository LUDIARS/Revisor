# 反対モデルレビューの設定化と既定レビュアーの Claude 系列化

## 目的

作成者の provider から相手系列を選ぶ「反対モデルレビュー」が固定実装のため、実装委託が
Claude 主体になった現在はほぼ全ての local PR が `codex-sol` へ流れ、Codex
(gpt-5.6-sol / gpt-5.6-terra) の推論コストだけが積み上がっている。反対モデルレビューを
設定で選べるようにし、既定を無効・既定レビュアーを `claude-opus` にすることで、審査モデルを
運用側から寄せられるようにする。捨てるトレードオフは「作成者と別のモデルが見る」独立性で、
必要な運用は設定で戻せる。

## 完了条件

- 設定 `oppositeModelReviewEnabled` (既定 false) を追加し、無効時は作成者の provider に
  関係なく `fallbackReviewer` を審査に使う。有効時は従来の反対モデル選択を厳密に維持する。
- `fallbackReviewer` の既定を `claude-opus` に変更し、保存済みの既知 2 値
  (`codex-sol` / `claude-opus`) は既定の入れ替えで書き換わらない。
- 設定 UI から新トグルを保存・復元でき、不正な `fallbackReviewer` は既定へ落とさず拒否する。
- 容量不足時の系列切替 (`claudeSessionCapacityUnavailable` / `alternateReviewer` /
  capacity fallback) と `forcedReviewModel` の優先関係を変更しない。
- 設定の意味・既定を変えた理由をコード内コメントと spec (SPEC-OPPOSITE-MODEL-REVIEW) に残し、
  レビュアー選択と設定解釈の責務を混ぜない。
- 変更に対応する単体テストを追加・更新する。
