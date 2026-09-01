---
task: anatomia-gate-fail-closed-and-spec-kinds
project: Revisor
kind: 実装
created: 2026-09-01
memory_links:
  - project-anatomia-dual-layer-rollout
  - project-revisor-test-review-split
  - feedback-new-impl-declare-anatomia-domain
---
# Anatomia gate を fail-closed にし、spec 宣言ファイルを実行系から外す

## 目的
neco 指示 (2026-09-01)「ドメインを定義する前にコードを書かない」を Revisor 側で強制する。
AIFormat `RULE_CODE.md` I-0 (2026-09-01 改訂、PR #1179 マージ済) は
「解析不能は pass ではなく fail」「Revisor gate は enforced」を担保層として明記した。
現状は (1) `anatomia-review-gate.mjs` が解析失敗を `unavailable` として **通過** させる
(Ostiarius/Cernere で 5 本連続)、(2) `anatomiaDualLayerGateMode` の既定が `advisory`、
(3) `spec/domains/*.json` / `.anatomia/*.json` が拡張子で `config` (実行系) に分類され、
ドメイン宣言だけの PR がフルビルドを課されてタイムアウトする (Memoria #1221)。

## 完了条件
- `runAnatomiaReviewGate` は CLI 解決失敗・解析失敗のとき `status: "blocked"` +
  `unavailable: true` + `reasons: ["Anatomia analysis unavailable: <phase>"]` を返す。
  生の例外文字列は永続化しない (既存テストの `RAW_DIAGNOSTIC_SHOULD_NOT_PERSIST` を維持)。
- `runner.mjs` の `status === "unavailable"` 分岐を `unavailable === true` に置き換える
  (blocked は既存の `buildAnatomiaBlockedResult` 経路で返る)。
- `config.mjs` の `anatomiaDualLayerGateMode` 既定を `enforced` にする。`advisory` は
  設定で明示したときだけ。不明値のフォールバックも `enforced`。
- `change-classification.mjs` に `SPEC_DECLARATION_FILE`
  (`spec/` と `.anatomia/` 配下の json/jsonl/jsonc/json5/yaml/toml) を `docs` kind として
  `config` より先に評価する規則を足す。`.mjs` 等の実行ファイルは `code` のまま。
- `test/anatomia-review-gate.test.mjs` / `test/config.test.mjs` /
  `test/change-classification.test.mjs` を上記に合わせて更新し `npm test` が green。
- Revisor local PR を提出し、マージ後は常駐 Revisor の再起動が必要なことを報告に含める
  (ワーカーは起動時のコードを保持する)。

## スコープ (編集可ディレクトリ)
- `src/anatomia-review-gate.mjs` / `src/runner.mjs` / `src/config.mjs` / `src/change-classification.mjs`
- `test/anatomia-review-gate.test.mjs` / `test/config.test.mjs` / `test/change-classification.test.mjs`

## 対象外
- `reviewStrategy()` の宣言と実装の乖離 (Memoria #1222) は別タスク。
- 各リポの登録テストケースへの `kinds` 付与は登録データの作業 (別タスク
  `2026-09-01-registered-test-kinds-rollout`)。
