---
type: feature
title: "review-plan — 変更種別と規模ごとの審査ステージ設計"
description: "レビュー開始時に変更種別からステージと登録テストを選び、差分規模とAnatomiaドメイン数からレビューモデル・effort・分業方式を決める。"
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
  - ./review-cost-control.md
updated: 2026-08-13
---

# review-plan — 変更種別と規模ごとの審査ステージ設計

`src/review-plan.mjs` が正本。審査の最初に**変更プロファイル**を作り、
どのステージと登録テストを使うかを決める。Anatomia の初回結果が得られた後、差分規模と
編集ドメイン数からレビューモデル、effort、大規模差分での調査・判断分業を決める。
ドキュメント修正では脆弱性診断とコード解析を省略するが、通常モードのモデルレビューは
維持する。

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

## SPEC-PR-NARRATIVE-RECONCILIATION: PR タイトル・本文の整合

通常レビューでは、提出された diff を確認する審査の前段で、PR タイトルが変更全体を表して
いるかと、本文へ追加する短い解説を低コストモデルへ 1 回だけ問い合わせる。同じ head
SHA の成功済み整合は `pullRequest.narrative.headSha` をチェックポイントとして再実行しない。
これは PR 表示の補助であり審査判定ではないため、モデル・Git metadata・状態保存の失敗は
best-effort で無視し、`checkStatus` / `reasons` / その他のゲート結果を変更しない。

モデルを呼ぶ安全境界は審査本体と同じである。

- `verification` モードと cost-validation の reviewer skip 中はモデルを呼ばない。
- added diff の leakage scan が clean で、Anatomia front gate が block しなかった後にだけ呼ぶ。
- タイトルとコミット件名も外部モデルへ渡す直前に metadata leakage scan を行い、モデル応答も
  保存直前に再検査する。検出値は保存せず、検出時は整合だけを省略する。
- モデル呼び出しは review-stage executor を通し、他のモデルレビューと同じ容量制御に従う。
  実行権限は read-only、tier は economy、effort は low とする。
- タイトル・コミット件名・diff はすべて未信頼データとして JSON 化し、入力中の命令に従わず、
  ツールや追加ファイルを使わないようプロンプトで明示する。

応答は `{title: string|null, explanation: string}` だけを受理する。タイトルは制御文字と改行を
除去して 100 文字を上限とし、日本語を含まない値と空値を拒否する。解説も制御文字を除去して
2,000 文字を上限とし、日本語を含まない値と空値を拒否する。解説中の Markdown 見出しは
escape し、既存本文の fenced code block 内にある
`## 解説` は置換対象にしない。既存の実見出し `## 解説` はその section だけを置換し、無ければ
末尾へ追加する。タイトルを変えた場合は、改行を平坦化した旧タイトルも解説へ残す。

結果保存時に現在の PR head SHA を再確認し、一致する PR の title/body と narrative
チェックポイントだけを更新する。worker から reporter への callback がこの保存を担当し、
runner やモデルは state store を直接操作しない。

登録テストは prompt の未信頼入力境界、応答 shape と sanitizer、CRLF・fenced code block を含む
section 置換、leakage / verification / checkpoint / cost skip、head 一致時だけの reporter 更新、
および review request への title/body/checkpoint 引き渡しを検証する。

## レビューコスト段階

計画は必須ステージ `reviewer_autofix` を省略しない。ただしその実行方式を変更
プロファイルから決め、PR のレビュー計画に記録する。

| 条件 | 実行 |
|---|---|
| コード変更行数が設定 X を超える | Sonnet + Opus または Terra + Sol。低コスト側が read-only 調査、強い側が high effort で判断・修正。 |
| Anatomia の編集ドメイン数が設定 Y 以上 | Opus または Sol を high effort で単独実行。 |
| 単一ドメインの機能、またはコード以外 | Sonnet または Terra を medium effort で単独実行。 |

既定値は X=1000、Y=3。設定画面から変更できる。コード変更行数は unified diff の
うち `code` 分類ファイルの追加・削除本文だけを数え、ドキュメントや diff header を
含めない。モデルへ渡す前に登録 base の一致、空でない changed paths と patch を確認する。

`intentReviewCompleted=true` の PR は、head SHA が変わっても同じ方針のモデルレビューを
繰り返さない。同じ reviewed head の再審査では失敗した tests / leakage / Anatomia / security
だけを再実行する。ただし前回の計画が model-advised なら、検証のみモードへ助言済み skip を
持ち込まないため全決定的ゲートを再実行する。tests または leakage のため security が skip
されていた場合は、その依存先として security も再実行する。head が変わった場合もモデルを
呼ばず、leakage・登録テスト・Anatomia・security の決定的ゲートをすべて新しい head で
再実行する。このとき前回の助言済み計画は流用せず、現在差分の変更種別から決定的に再計画し、
complexity baseline と動作確認判定も現在の merge-base と head に対して更新する。

通常レビューへ戻すのは、intent review がまだ完了していない、reviewer が方針判断に必要な情報
不足を返した、または validation mode 設定が変わって review policy 自体が変化した場合だけとする。

reviewer と限定 test autofix の編集が終わった後、コミット対象の最終差分へ Anatomia を1回
再実行する。target domain、architecture、complexity のゲートは、この最終結果だけで判定する。

### コスト・品質・速度の検証モード

設定 `costValidationModeEnabled` を有効にすると、モデルレビュー、Genius judgment、
Anatomia domain review を `status: "skipped"` として計画へ記録する。この3項目の省略は
blocking reasonにせず、登録テスト、情報流出検査、securityなど残るゲートが通れば
Test OK・マージ可能とする。設定は通常運用の既定では無効。

Anatomia domain reviewだけを省略し、Anatomiaのquality/architecture解析は維持する。
したがって実際のarchitecture errorやテスト失敗、情報流出、security findingまで
検証モードが合格へ変えることはない。

### code_analysis 省略の実効

Anatomia の `pr-review` は domain / quality / architecture を 1 回の呼び出しで
返すため、head 側の解析呼び出しは残る。省略されるのは

- プロジェクト全体解析 (`ensureInitialAnalysis`)
- base worktree のベースライン解析 (complexity 差分の相手側)
- quality / architecture の**ゲート適用** (advisory へ降格、`review-gate.md`)

の 3 つ。時間の大半は前 2 つなので、実測上の節約はここで得られる。
ベースラインが無い審査では `complexityScoreDelta` は `null` になり、
複雑度低下によるブロックは発生しない。
保存済みレビューにベースラインスコアだけがあり、対応する関数数を 0 より大きい数値として
確認できない場合も、比較可能な実測ベースラインとは扱わず `complexityScoreDelta` を `null` にする。

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

`planAdvisor` は全レビュー計画で利用できる。ただし既定は `none` であり、`reviewer` は
レビュー本体とは別のモデル呼び出しになるため、必要性を確認して明示設定する。

**Augur をデーモン無しの CLI とする前提**の契約がこれ。Augur は目的駆動の
テスト計画をすでに責務として持つため、同じ判断を Revisor 側で再実装しない。

依頼 JSON (`advisorRequest`):

```json
{
  "version": 1,
  "repository": "LUDIARS/Revisor",
  "pullRequest": { "number": 7, "title": null },
  "changeProfile": { "kinds": ["docs"], "counts": {}, "changedFiles": 1,
                     "changedLines": 12, "docsOnly": true, "docsOrConfigOnly": true,
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
