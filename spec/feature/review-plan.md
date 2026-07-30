---
type: feature
title: "review-plan — 変更種別ごとの審査ステージ設計"
description: "レビュー開始時に変更種別からステージと登録テストを選び、毎回すべてを走らせない。決定的ルールが正本で、Augur CLI または管制 LLM は安全下限の内側でのみ計画を調整できる。"
service: revisor
domain: review-plan
tags:
  - ci-planning
  - change-classification
  - augur
status: implemented
related:
  - ../architecture.md
  - ./review-gate.md
  - ./merge-risk.md
updated: 2026-07-30
---

# review-plan — 変更種別ごとの審査ステージ設計

`src/review-plan.mjs` が正本。審査の最初に**変更プロファイル**を作り、
どのステージと登録テストを走らせるかを決める。ドキュメント修正のたびに
脆弱性診断とコード解析を回すのをやめるための仕組み (neco 2026-07-30)。

## 変更プロファイル

`src/change-classification.mjs` がパス集合と unified diff から作る。

- **種別 (kind)**: 1 パス 1 種別。優先順で最初に一致したものを採る。
  `generated` → `test` → `docs` → `infra` → `asset` → `config` → `code`。
  lock ファイルは config より先に generated、workflow は config より先に infra、
  拡張子が `.mjs` でも `test/` 配下なら test、と順序自体が判断になっている。
- **runtime surface**: `migration` / `entrypoint` / `ui` / `infra`。
  登録単体テストでは代替できない面。docs-only 変更は `ui/` 配下でも
  runtime surface を持たない (実行物が動いていないため)。
- **規模**: 変更ファイル数と diff 本文行数 (`+++`/`---` はヘッダなので数えない)。

## ステージ

| id | 必須 | 省略条件 |
|---|---|---|
| `leakage_scan` | ✔ | 省略不可 |
| `anatomia_domain_review` | ✔ | 省略不可 (ドキュメントも自身がドメイン) |
| `spec_requirements` | ✔ | 省略不可 |
| `reviewer_autofix` | ✔ | 省略不可 |
| `anatomia_code_analysis` | | 実行コードを含まない変更 (docs/asset/generated のみ) |
| `security_review` | | 同上 |
| `registered_tests` | | 変更種別を担当する登録テストが 1 件も無いとき |

`leakage_scan` を必須にしているのは、このワークフローが存在する理由そのもの
(作業ブランチと秘匿情報をリモートへ出さない) だから。`anatomia_domain_review` と
`spec_requirements` を必須にしているのは、doc レビューでも「ドメイン整合」と
「spec 要件充足」は見たいという neco の明示指示による。

### code_analysis 省略の実効

Anatomia の `pr-review` は domain / quality / architecture を 1 回の呼び出しで
返すため、head 側の解析呼び出しは残る。省略されるのは

- プロジェクト全体解析 (`ensureInitialAnalysis`)
- base worktree のベースライン解析 (complexity 差分の相手側)
- quality / architecture の**ゲート適用** (advisory へ降格、`review-gate.md`)

の 3 つ。時間の大半は前 2 つなので、実測上の節約はここで得られる。
ベースラインが無い審査では `complexityScoreDelta` は `null` になり、
複雑度低下によるブロックは発生しない。

### autofix 後の再計画

計画は提出時の差分から 1 度だけ決めるが、**相互モデルレビューが実行コードを
追加した場合だけ**は、レビュー後の差分から決定的に再計画する
(`src/runner.mjs`)。docs-only 用の計画は登録テストと code_analysis のゲートを
落としているので、そのまま最終テストとゲートに使うと「テストを 1 件も走らせずに
新しいコードをマージする」ことになる。docs-only 緩和が最終差分に追従するのと
同じ理由であり、同じ場所で行う。再計画時は管制プランナーの助言を捨てる。
助言はもう存在しない変更についての回答だから。

セキュリティスキャンは 1 審査 1 回のまま (autofix 後には再実行しない) で、
追加されたコードはマージ直前のスキャンが見る。ただし記録する `skipped` の理由は
再計画に追従させる。再計画が `security_review` を要求した審査で
`not required by the review plan` を残すと、板が既に偽になった理由を表示すること
になるため。

## 登録テストの選択

テストケースは任意で担当範囲を宣言できる。

- `kinds`: 担当する変更種別の配列。変更種別と 1 つでも交差すれば実行。
- `always: true`: 常に実行 (省略対象外)。
- `runtime: true`: 「動作テスト」。通過すると動作確認の必要性を下げる
  (`merge-risk.md`)。

宣言が無いケースは**実行コードを含む変更のみ担当**として扱う。既存登録は
すべてこの扱いになり、コード変更に対する挙動は従来どおり、docs-only 変更では
走らなくなる。省略したケースは消えるのではなく `status: "skipped"` と理由付きで
残り、UI と advisory に出る。「短い一覧」を「小さいテストスイート」と
読み違えさせないため。

## 管制プランナー (任意)

決定的な計画が正本 (floor)。設定 `planAdvisor` で相談先を選べる。

- `none` (既定): 決定的ルールのみ。
- `augur`: `<augurFolder>/bin/augur.mjs review-plan --json` を実行し、
  stdin に計画依頼 JSON を渡す。ローカル・オフラインの CLI。
- `reviewer`: レビュアーと同じモデル CLI に JSON で答えさせる。

**Augur をデーモン無しの CLI とする前提**の契約がこれ。Augur は目的駆動の
テスト計画をすでに責務として持つため、同じ判断を Revisor 側で再実装しない。

依頼 JSON (`advisorRequest`):

```json
{
  "version": 1,
  "repository": "LUDIARS/Revisor",
  "pullRequest": { "number": 7, "title": null },
  "changeProfile": { "kinds": ["docs"], "counts": {}, "changedFiles": 1,
                     "changedLines": 12, "docsOnly": true,
                     "touchesSpec": false, "runtimeSurfaces": [] },
  "stages": [{ "id": "security_review", "run": false, "reason": "…" }],
  "testCases": [{ "name": "unit", "kinds": null, "runtime": false, "always": false }],
  "stageIds": ["leakage_scan", "…"]
}
```

応答 (`{"stages":[{"id","run","reason"}],"testCases":["<name>"]}`) は
前後に散文があってもよい。ブレース深度走査で釣り合った最上位オブジェクトを
集め、最後の 1 件を採る。文字列内の `}` はオブジェクトを閉じない。

### 安全下限 (`applyAdvisedPlan`)

- 必須ステージは**落とせない**。落とす要求は却下として記録に残す。
- 実行コードを含む変更では**登録テストを削れない** (再有効化のみ可)。
- 登録されていないテストケース名は無視する。
- 省略できるのは `anatomia_code_analysis` と `security_review`、および
  実行コードを含まない変更の `registered_tests` だけ。
- `anatomia_code_analysis` の省略で節約されるのは高価な解析 (プロジェクト全体・
  base ベースライン) までで、**ゲートは緩まない**。quality / architecture の
  advisory 降格は決定的ルールが落としたときだけ成立する (`review-gate.md` の
  `codeAnalysisGating`)。管制 LLM が「不要」と言うだけで severity=error の
  アーキテクチャ違反をブロックから外せてはならない。
- 相談先が未設定・不在・失敗・応答不正のときは決定的な計画をそのまま使い、
  理由を `advisorError` に残す。**壊れたプランナーが審査を止めることはない。**
- 外部モデル (`reviewer`) は leakage スキャンが clean のときしか起動しない。
  審査本体と同じ境界。`augur` はローカル CLI かつ差分を渡さないため対象外。
- 外部モデルは**書き込み権限無し**で起動する (`runReviewer({ readOnly: true })`
  → claude は `--permission-mode plan`、codex は `--sandbox read-only`)。
  計画は質問であって編集ではなく、head worktree の内容はこの後コミットされる。
  「編集するな」とプロンプトで頼むだけの防御にしない。
- 検証のみモード (`reviewMode: "verification"`) はモデルを一切呼ばないので
  決定的な計画に固定する。

管制プランナーが落としたステージは `advisedSkips` に記録し、マージリスクの
加点要因になる (`merge-risk.md`)。薄い審査を厚い審査と同じ安全さに見せない。
