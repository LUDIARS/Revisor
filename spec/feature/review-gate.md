---
type: feature
title: "review-gate — マージ可否判定ポリシー"
description: "ローカル PR の審査結果を reasons (ブロック) / advisories (非ブロック) に振り分ける判定ポリシー。docs/設定ファイルのみの変更は対象ドメイン欠如を advisory に緩和し、ドメインレビュー自体は維持する。環境依存の coupling_delta も advisory 扱い。セキュリティスキャンの所見と未完了はブロックする。"
service: revisor
domain: review-gate
tags:
  - merge-gate
  - policy
  - docs-only
  - config-only
  - security-scan
status: implemented
related:
  - ../architecture.md
  - ./review-plan.md
  - ./merge-risk.md
updated: 2026-07-30
---

# review-gate — マージ可否判定ポリシー

`src/review-gate.mjs` が正本。審査 1 回分の材料 (CI 結果・Anatomia 最終解析・
complexity 差分・レビュアー出力・leakage スキャン・セキュリティスキャン結果) を
受け取り、**reasons (マージブロック)** と **advisories (表示のみ)** に振り分ける。

## ブロック条件 (reasons)

- 登録テストの失敗
- 対象ドメイン欠如 (**docs / 設定ファイルのみの変更を除く**、下記)
- `spec_linkage` / `coupling_delta` 以外の Anatomia ゲート不合格
  (ゲート名なしの検証失敗もブロック)
- severity=error の変更行アーキテクチャ違反
- complexity スコアの閾値超過低下
- レビュアーの `PR_GATE_NEEDS_HUMAN` 報告
- 情報流出所見
- 設定 severity 以上のセキュリティ finding (`status: "findings"`)
- セキュリティスキャンの未完了 (`status: "error"`) — 未完了を合格として読ませない
- 解釈できないセキュリティスキャン結果 (既知 status 以外) — 判定不能を合格として
  読ませない

## advisory 条件 (非ブロック)

- `spec_linkage` ゲート不合格
- `coupling_delta` ゲート不合格 (下記)
- 孤立関数 (orphan)
- error 未満のアーキテクチャ違反
- **docs / 設定ファイルのみの変更の対象ドメイン欠如**
- レビュー計画が担当外とした登録テスト (`status: "skipped"`)
- 決定的ルールが `anatomia_code_analysis` を落としたときの全ゲート・全違反
- 設定無効 (`disabled by settings`) 以外の理由でスキップされたセキュリティスキャン

## レビュー計画による降格 (neco 決定 2026-07-30)

**決定的ルール**が `anatomia_code_analysis` を落とした審査では、
quality / architecture のゲートと違反を**ブロックにしない**。ベースラインが
無いので complexity 差分も `null` になり、複雑度低下でのブロックも起きない。
計画が「この変更に不要」と判断した検査の所見でブロックすると、誰も依頼して
いない証拠で変更を止めることになるため。ゲートの他条件 (テスト失敗・leakage・
対象ドメイン・`PR_GATE_NEEDS_HUMAN`) は不変。

降格の根拠は「その変更はコード解析の証拠を負っていない」であり、これが成り立つ
のは実行コードを含まない変更だけ。したがって**管制プランナーの省略要求では降格
しない** (`codeAnalysisGating`)。head 側の `pr-review` 解析はどちらの場合も走って
おり、所見は実在する。管制 LLM が「このステージは不要」と言うだけで
severity=error のアーキテクチャ違反をブロックから外せるなら、それはマージゲート
ではなくなる。省略で節約されるのは高価なベースライン解析であって、ゲートの
厳しさではない。

登録テストの `skipped` は失敗ではない。ブロック判定は `status === "failed"`
だけを見る。

セキュリティスキャンも計画で落とせる。`security_review` を落とした審査では
`codex-security` CLI を起動せず、`skipped` (理由: `not required by the review
plan`) として記録する。これは advisory であって pass ではない。docs 変更のたびに
1 回あたりのコスト上限まで払って「攻撃面はありません」と言わせるのが、計画が
無くそうとしている無駄そのものだから。

## docs / 設定ファイルのみの緩和 (neco 決定 2026-07-30)

ドキュメントは docs-only 変更にとってそれ自体がドメインであり、コード対象
ドメインの欠如でブロックするのは不合理。設定ファイルも同じで、設定はそれ自体が
ドメインを持たないため、ゲートを残すと設定変更が永久にマージできない
(`excubitor.catalog.yaml` の 1 行変更が実際にブロックされた: Genius#6)。
ルールは緩和し、ドメインレビューは維持する。

- 判定: `isDocsOnlyChange` — 変更ファイルが 1 件以上あり、全てが
  `.md/.markdown/.mdx/.txt/.adoc/.rst` のとき docs-only。
  パス列挙は `git diff --name-only -z` (非 ASCII パスの C-quote 回避) と
  `git ls-files --others --exclude-standard -z` の和集合。`git diff` は追跡済み
  ファイルしか報告しないため、後続の `git add --all` がコミットする未追跡の
  新規ファイルを取りこぼさないよう同じ除外規則で併せて列挙する。
- 判定: `isDocsOrConfigOnlyChange` — 変更ファイルが 1 件以上あり、全てが
  上記ドキュメント拡張子または設定ファイル
  (`.yaml/.yml/.json/.jsonc/.json5/.toml/.ini/.cfg/.conf/.properties` と
  `.env.example/.env.sample/.env.template/.editorconfig/.gitignore/
  .gitattributes/.gitmodules/.npmrc/.nvmrc/.dockerignore/.eslintignore/
  .prettierignore`) のとき docs/config-only。コード拡張子は 1 つも含めない
  (設定を書いた `.mjs` はコードであり、対象ドメインを負う)。docs と設定が
  混在した変更も緩和対象で、コードが 1 件でも入れば緩和は消える。
- 例外: **依存マニフェスト** (`package.json`・`package-lock.json`・
  `npm-shrinkwrap.json`・`yarn.lock`・`pnpm-lock.yaml`・`Cargo.toml`・`Cargo.lock`・
  `pyproject.toml`・`requirements*.txt`・`poetry.lock`・`Gemfile`・`Gemfile.lock`・
  `composer.json`・`composer.lock`・`go.mod`・`go.sum`) は拡張子上は設定に見えるが
  緩和しない (neco 2026-07-30)。これらの変更は第三者コードをビルドへ持ち込む変更で
  あり、ゲートを保つべき変更種別だから。docs と組み合わせても緩和されない。
- 例外: **実行を定義する設定** (`.github/workflows/`・`.circleci/`・`.gitlab/` 配下と
  `.gitlab-ci.yml`・`docker-compose*.yml`・`azure-pipelines*.yml`・`cloudbuild.yaml`)
  も緩和しない。これらは設定値ではなく「何が・どの資格情報で実行されるか」を書く
  ファイルで、依存マニフェストと同じ理由でゲートを保つ。変更種別分類でも
  workflow は `config` より先に `infra` と判定される。緩和しなければ拡張子を持たない
  `Dockerfile` (元から緩和対象外) との非対称も生まれない。
- 再判定: 最終ゲートは**レビュー後の差分**で docs-only を判定し直す。autofix が
  コードへ及んだ変更はもう docs-only ではなく、対象ドメイン欠如は再びブロックする。
  autofix が新規コードファイルを追加した場合も同様 (未追跡ファイルを列挙する理由)。
- 共有: 「まだコード対象ドメインを要するか」は `needsTargetDomain` が単一定義。
  マージゲート・レビュアープロンプト・humanQuestion が同じ判定を共有し、
  片方だけ緩和が効かない状態を作らない。
- 維持されるもの: 相互モデルレビューは docs-only / 設定のみでも実行する
  (仕様と記述・設定値の整合性チェック)。`PR_GATE_NEEDS_HUMAN`・登録テスト・
  leakage・複雑度・severity=error のアーキ違反・セキュリティスキャンの
  ブロックは不変。緩和されるのは対象ドメイン欠如だけ。
- 緩和しないもの: マージリスクの `missing_domain` 加点は据え置き
  (ブロックではなく人間の判断要否の重み付けであり、ゲートとは別軸)。

## coupling_delta の advisory 化 (neco 決定 2026-07-30)

Anatomia の一時 pr-review 解析は、`coupling_delta` の percentile 閾値と
コールグラフを解析環境から導出する。同一コミットがレビュー用 worktree では
p95=9 (14 関数が該当) となり、クリーンなローカル worktree では p95=9.9
(該当なし) となる実測があった (Concordia#3)。Anatomia 側で非決定性が解消される
までは、環境依存の判定でマージをブロックしない。結合度の増加は advisory として
記録・表示は続ける。

## セキュリティスキャン結果の扱い

`src/security-scan.mjs` (`codex-security`) の結果を `security` として受け取る。
判定は status のみで決まり、ゲートはスキャナを起動しない。

- `findings`: `totalFindings` 件と閾値 `failOnSeverity` を reasons に記録する。
  `totalFindings` は閾値以上の finding だけを数える (レポートが閾値未満の
  finding も併記しうるため)。順序が定義できない severity は比較不能なので
  除外せず数える。件数が下限値 1 になる場合は測定値と区別するため `reason` を
  併記する: レポートが読めなかったときは `the scan report could not be read`、
  読めたが閾値以上の finding が無かったときは
  `the scan report listed no finding at or above the threshold`。
- `error`: スキャン未完了を reasons に記録する。理由は終了コードのみで、
  スキャン対象を引用しうる stderr は保持しない。
- `skipped`: 設定無効 (`disabled by settings`) のときは無音。leakage ゲートや
  登録テストが既にブロックしているためのスキップは advisory
  (ブロック理由は既に別途記録済み)。
- 未指定 (`undefined`): runner は常に結果を渡すため、判定材料としては扱わない。
- 既知 status 以外 (`passed`/`findings`/`error`/`skipped` のいずれでもない):
  合格と読めないためブロックする (`the security scan produced no usable result`)。
  マージ直前の `assertMergeSecurityScan` と同じ fail-closed 規則で、審査時点と
  マージ時点の判定が食い違わないようにする。
