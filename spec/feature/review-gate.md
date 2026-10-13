---
type: feature
title: "review-gate — マージ可否判定ポリシー"
description: "ローカル PR の審査結果を reasons (ブロック) / advisories (非ブロック) に振り分ける判定ポリシー。業務コードを含まない変更は application domain の対象外とし、他の審査は維持する。Anatomia の warn 相当ゲート (spec_linkage / coupling_delta / convention_drift) は advisory 扱い。セキュリティスキャンの所見と未完了はブロックする。"
service: revisor
domain: review-gate
tags:
  - merge-gate
  - policy
  - docs-only
  - config-only
  - non-code
  - security-scan
status: implemented
related:
  - ../architecture.md
  - ./review-plan.md
  - ./merge-risk.md
updated: 2026-09-04
---

# review-gate — マージ可否判定ポリシー

`src/review-gate.mjs` が正本。審査 1 回分の材料 (CI 結果・Anatomia 最終解析・
complexity 差分・レビュアー出力・leakage スキャン・セキュリティスキャン結果) を
受け取り、**reasons (マージブロック)** と **advisories (表示のみ)** に振り分ける。

## ブロック条件 (reasons)

- 登録テストの失敗
- 対象ドメイン欠如 (**業務コード (`kind=code`) を含まない変更**と**解析可能な変更関数が
  1 件も無い変更**を除く、下記)
- Anatomia の **block 相当ゲート** (`rule_conformance` / `duplication`)、および
  advisory 集合に載っていないゲートの不合格 (未知のゲートは fail-closed で
  ブロックする。ゲート名なしの検証失敗もブロック)
- severity=error の変更行アーキテクチャ違反
- レビュアーの `PR_GATE_NEEDS_HUMAN` 報告
- 情報流出所見
- 設定 severity 以上のセキュリティ finding (`status: "findings"`)
- セキュリティスキャンの未完了 (`status: "error"`) — 未完了を合格として読ませない
- 解釈できないセキュリティスキャン結果 (既知 status 以外) — 判定不能を合格として
  読ませない

## advisory 条件 (非ブロック)

- complexity スコアの閾値超過低下。リスク加点にも使わず、プロジェクトの
  [リファクタリング提案](refactoring-proposal.md) として報告する。
- Anatomia の **warn 相当ゲート** の不合格 (下記):
  `spec_linkage` / `coupling_delta` / `convention_drift`
- 孤立関数 (orphan)
- error 未満のアーキテクチャ違反
- **docs / 設定ファイルのみの変更の対象ドメイン欠如**
- **解析可能な変更関数が無い変更の対象ドメイン欠如**
- **業務コードを含まない変更の対象ドメイン欠如**
- レビュー計画が担当外とした登録テスト (`status: "skipped"`)
- 決定的ルールが `anatomia_code_analysis` を落としたときの全ゲート・全違反
- 設定無効 (`disabled by settings`) 以外の理由でスキップされたセキュリティスキャン
- `REVISOR_CONFIDENTIAL_TERMS_FILE` で設定された公開不可語が追加差分に現れた所見

## SPEC-CONFIDENTIAL-TERM-ADVISORY: 公開不可語の追加差分検査

資格情報の定型パターンでは検出できない未公開プロダクト名・顧客名・組織名を、
`src/confidential-terms.mjs` が追加差分の本文とファイルパスから大文字小文字を区別せず検出する。
語そのものはリポジトリへ置かず、`REVISOR_CONFIDENTIAL_TERMS_FILE` が示す外部 JSON の
`keywords` 配列から読む。未設定時はこの任意検査だけを省略する。
設定時は絶対ローカルパスと1件以上の有効語を必須とし、相対パスと UNC パスは拒否する。

結果は既定では advisory とする。既存の識別子・API パスに該当語が使われている
リポジトリを直ちに全面停止させず、許可整理後に enforced 化できるようにするためである。
永続化され得る情報は安全な term id、パス、行番号に限定し、一致本文は保持しない。
パス自体が一致した場合はパスを不透明な連番へ置換する。term id は短い ASCII 識別子だけを
受理し、いずれかの登録語を含む id、重複 id、制御文字を含む id は連番 id に置換する。
設定ファイルの読込・JSON parse エラーにも設定パス、OS エラー、入力断片を含めない。
パス検査には NUL 区切りの raw changed-path 一覧も使い、本文差分に `+++` header が無い
binary file や Git が C-quote した非 ASCII パスも見落とさない。本文側のパスを解釈できない
場合も検査自体は継続し、所見のパスだけを固定の不透明ラベルへ置換する。

語ごとに照合方法を選べる (neco 指示 2026-10-14)。短い固有名を部分一致で登録すると一般語の一部に当たり、
公開リポジトリの PR が一斉に止まるためである。

```json
{ "id": "product-002", "value": "XYZ", "match": "word", "caseSensitive": true }
```

- `match`: `substring` (既定) は部分一致。`word` は前後が文字・数字でない位置だけで一致する
  (`XYZ/` や `XYZ_` は一致、`XYZA` や `aXYZ` は不一致)。
- `caseSensitive`: 既定 `false`。`true` のとき大文字小文字を区別する。
- 未知の `match` と真偽値でない `caseSensitive` は設定エラーとして扱う。
- パス・追加差分・件名本文・squash commit 本文のすべてで同じ規則 (`confidentialTermMatches`) を使う。

提出後に test autofix またはレビュアーが変更した場合、advisory は提出時差分ではなく
コミット対象の最終差分から作る。これにより自動修正が持ち込んだ公開不可語も検出する。
登録テストは本文一致、パス一致時の秘匿、削除・文脈行の除外、大文字小文字、id の無害化、
設定エラーの非漏洩を検証する。

## SPEC-CONFIDENTIAL-TERM-ENFORCEMENT: 公開不可語のブロック (neco 決定 2026-09-15)

公開リポジトリに未公開の固有名と素材パスが再流出した。advisory は設定されていてもマージを止めないので、
語ファイルが次の宣言を持つとき、公開不可語を**ブロック**する。

```json
{ "keywords": [ ... ],
  "enforcement": { "mode": "enforce-except", "exceptRepositories": ["owner/name", "owner/*"] } }
```

- `exceptRepositories` に一致しないリポジトリでは、所見を審査の reason (マージ不可) にする。一致する
  リポジトリと、`enforcement` を持たない語ファイルでは従来どおり advisory。
- 例外の一覧も語ファイル側に置く。公開される catalog や設定に、語を正当に扱う非公開リポジトリの名前を
  書かないため。新しく作られた公開リポジトリは宣言の更新を待たずに守られる。
- リポジトリ名が分からない審査は例外に当たると証明できないのでブロックする。
- 検査対象は追加差分・パスに加え、local PR の件名と本文。squash commit の本文としてそのまま公開面に
  出るからである。所見の場所は `[pr-title]` / `[pr-body]` と行番号だけにする。
- 語ファイルが設定されているのに読めない・`enforcement` の形が崩れている場合は、例外判定ができないので
  固定文言の reason でブロックする (無言の advisory 降格をしない)。文言にパス・エラー・入力断片を含めない。
- `squashMergeLocalPullRequest` は状態確認の直後、base を進める前に件名・本文をもう一度検査する。
  審査の後に件名・本文が書き換えられても公開前に止めるためで、実 finding と同じくバイパスマージでも止める。
  例外文は term id と件数だけを持つ。

登録テストは advisory の維持、例外外リポジトリのブロックと語の非表示、完全一致と owner ワイルドカードの例外、
件名・本文の件数計上、崩れた宣言の fail-closed、squash commit 本文の拒否 (バイパス時を含む) と base 不変、
審査結果で reason へ振り替わることを検証する。

## SPEC-CONFIDENTIAL-TERM-CATEGORIES: IP・PC のフルパス・マシン名・拠点名 (neco 指示 2026-10-13)

公開リポジトリの手順書に、ホスト名・LAN IP・Tailscale IP・SSH ユーザ名が書かれたまま公開されかけた。
資格情報の定型パターンと辞書の固定語だけでは素通りするため、同じ語ファイル・同じ経路で次の種類も検査する。

| 種類 | 検出 | 対象外 |
|---|---|---|
| `private-ip` | 組込み (`src/host-identifiers.mjs`)。10/8、172.16/12、192.168/16、100.64/10 (Tailscale)、169.254/16 の具体的なホスト | 127/8・0.0.0.0・文書用範囲・公開アドレス・CIDR 表記 (`/24` 等)・末尾 `.0` / `.255` |
| `local-path` | 組込み。Windows のドライブ絶対パス、`/Users/<名前>/`、`/home/<名前>/` | `<...>`・`${VAR}`・`%VAR%`・`{...}` のプレースホルダ、`~` 始まり、URL の一部 |
| `machine-name` | keywords の `category: "machine-name"` の固定語 | — |
| `site-name` | keywords の `category: "site-name"` の固定語 | — |

```json
{ "keywords": [ { "id": "machine-001", "value": "<固定語>", "category": "machine-name" } ],
  "categories": { "private-ip": "advisory", "local-path": "advisory", "machine-name": "advisory", "site-name": "enforce" },
  "enforcement": { "mode": "enforce-except", "exceptRepositories": ["owner/name"] } }
```

- 正規表現は語ファイルに書かせない。誤った式が黙って検査を無効にするため、形で分かる種類は組込みにする。
- `categories` は種類ごとに `advisory` / `enforce` / `off`。書かれていない種類は **advisory** (新しい種類の既定)。
  知らない種類名・扱いは読込失敗 (fail-closed) にし、綴り違いで検査が消えないようにする。
- category の無い従来の語は従来どおり `enforcement` に従う。enforce の種類は `exceptRepositories` の例外を共有する。
- 組込み検出器は追加行と PR 件名・本文だけを見る (リポジトリ相対のファイルパスは IP・フルパスの形にならない)。
  固定語の種類はファイルパスも従来どおり見る。
- 所見は `{ termId, path, line, kind }`。組込みの termId は種類名。値そのものは所見にも文面にも載せない。
  文面は種類つきの所見があるときだけ末尾に `[種類: local-path 2, private-ip 1]` を足す (従来の語だけなら文言は不変)。
- 1 回の審査で advisory と reason の両方が出ることがある (種類ごとに振り分けるため)。
- squash commit 本文の最終検査も、enforce の種類だけで止める。
- AIFormat の leak-checker が同じ規則を持つ。規則を変えるときは両方を揃える。

登録テストは検出と対象外の境界、種類の既定 advisory、従来の語の enforcement 維持、enforce / off の切替、
PR 本文と squash 本文での種類別の扱い、知らない種類・扱いの fail-closed、値の非表示を検証する。

## SPEC-CONFIDENTIAL-TERM-EXCLUSIONS: 種類つき所見の除外ルール (neco 決定 2026-10-13)

公開リポ 273 checkout の監査で local-path 195,848 件・private-ip 1,368 件・machine-name 461 件が出て、
大半が生成レポートとテストだった (private-ip はテストを除くと 181 件、machine-name は 450 件がテスト)。
種類つきの所見 (`private-ip` / `local-path` / `machine-name` / `site-name`) に次の除外を入れる。
判定は `src/leak-exclusions.mjs`。category の無い従来の語には使わない。

| 除外 | 規則 | 対象の種類 |
|---|---|---|
| 生成レポート | `report/` 配下、`*.html` / `*.htm` / `*.html.json` | すべての種類つき |
| テスト | `test/`・`tests/`・`__tests__/`・`fixture/`・`fixtures/` 配下、`*.test.*`・`*.spec.*` | すべての種類つき |
| ワークスペースルート配下だけの行 | 行内の具体的な PC のフルパスが 1 つ以上あり、すべて `workspaceRoots` のどれかの配下 | `local-path` |

- パス規則は監査の集計と同じ式。ワークスペースルートの定義も監査と同じ「行内のドライブパスがすべてルート配下」で、
  加えて `/Users/<名前>/`・`/home/<名前>/` もルート外のパスとして数える (同じ行のホームのパスを一緒に除外しない)。
- ルートは PC のフルパスなのでリポジトリに置かない。語ファイルの `workspaceRoots: ["<絶対パス>"]` で渡す。
  書かれていなければワークスペースルートの規則は効かない。配列でない・ドライブ直下や `/` 直下の 1 段・相対パスは
  読込失敗 (fail-closed)。
- PR 件名・本文と squash commit 本文はリポジトリのパスを持たないので、効くのはワークスペースルートの規則だけ。
- 除外した件数は差分検査の結果に `excludedFindings` として残す (値は持たない)。
- AIFormat の leak-checker (`scripts/leak-checker/leak-exclusions.mjs`) が同じ規則を持つ。規則を変えるときは両方を揃える。

登録テストはパス規則の境界、ルートの正規化と fail-closed、ルート配下判定 (ルート外・ホーム・兄弟フォルダの接頭辞)、
従来の語を除外しないこと、enforce の種類がテスト・レポートでは止めないこと、PR 本文と squash 本文での扱いを検証する。

## レビュー計画による降格 (neco 決定 2026-07-30)

**決定的ルール**が `anatomia_code_analysis` を落とした審査では、
quality / architecture のゲートと違反を**ブロックにしない**。ベースラインが
無いので complexity 差分も `null` になり、複雑度低下の助言も出さない。
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
  (`.yaml/.yml/.json/.jsonl/.jsonc/.json5/.toml/.ini/.cfg/.conf/.properties` と
  `.env.example/.env.sample/.env.template/.editorconfig/.gitignore/
  .gitattributes/.gitmodules/.npmrc/.nvmrc/.dockerignore/.eslintignore/
  .prettierignore`) のとき docs/config-only。コード拡張子は 1 つも含めない
  (設定を書いた `.mjs` はコードであり、対象ドメインを負う)。docs と設定が
  混在した変更も緩和対象で、コードが 1 件でも入れば緩和は消える。
  `.jsonl` (JSON Lines) は `.json` と同じ宣言的データなので同列に置く。拡張子を
  `.json` 固定で書いていたため漏れており、生成物 `*.jsonl` の追跡をやめる変更が
  code と分類されて、持ちようのない対象ドメインを要求されていた (Concordia#12)。
  変更種別分類でも同じ理由で `.jsonl` は `config`。
- 例外: **依存マニフェスト** (`package.json`・`package-lock.json`・
  `npm-shrinkwrap.json`・`yarn.lock`・`pnpm-lock.yaml`・`Cargo.toml`・`Cargo.lock`・
  `pyproject.toml`・`requirements*.txt`・`poetry.lock`・`Gemfile`・`Gemfile.lock`・
  `composer.json`・`composer.lock`・`go.mod`・`go.sum`) は拡張子上は設定に見えるが
  この狭い docs/config-only 緩和の対象にしない (neco 2026-07-30)。これらの変更は
  第三者コードをビルドへ持ち込む変更であり、他のリスク信号を保つべき変更種別だから。
  docs と組み合わせても docs/config-only にはならない。ただし application domain の
  要否は下記の非コード変更ルールで別に判定し、依存マニフェストだけなら要求しない。
- 例外: **実行を定義する設定** (`.github/workflows/`・`.circleci/`・`.gitlab/` 配下と
  `.gitlab-ci.yml`・`docker-compose*.yml`・`azure-pipelines*.yml`・`cloudbuild.yaml`)
  も docs/config-only にはしない。これらは設定値ではなく「何が・どの資格情報で
  実行されるか」を書くファイルで、依存マニフェストと同じ理由で他のリスク信号を
  保つ。変更種別分類でも
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
  leakage・severity=error のアーキ違反・セキュリティスキャンの
  ブロックは不変。緩和されるのは対象ドメイン欠如だけ。
- 緩和しないもの: docs / 設定のみを理由とするマージリスクの `missing_domain`
  加点は据え置き (ブロックではなく人間の判断要否の重み付けであり、ゲートとは
  別軸)。解析可能な変更関数が無い場合は加点自体を止める (下記)。

## 解析対象の無い変更の緩和 (2026-08-01)

Anatomia のドメイン所属は**解析できた関数**から導出される。Anatomia が解釈しない
実行面 (`.bat` エントリポイントなど) だけを変更した PR は、対象ドメインが
「欠けている」のではなく**帰属させる対象が存在しない**。docs / 設定と同じ理由で、
ここでブロックすると変更は永久にマージできない。

- 判定: `hasAnalyzableChangedAnchors` — 解析結果が変更アンカーを 1 件でも
  主張していれば `true`。
- 参照する signal は 2 系統: `domain.unassignedAnchors` +
  `domain.targetDomains[].changedAnchors` と `quality.changedFunctions`。
  **どちらか一方でもアンカーを主張すれば `true`** とし、両方が明示的に空の
  ときだけ緩和する。片方だけを見て緩和すると、解析が部分的に欠けた payload で
  ゲートが黙って開く。
- 両 signal とも欠落した payload (旧版・壊れた payload) は fail-closed で
  `true`。緩和は「解析したが 0 件だった」という明示的な結果でだけ効く。
- 適用先: ゲート (`needsTargetDomain`)・レビュアープロンプト
  (`domainInstruction`)・`humanQuestion`・マージリスクの `missing_domain` 加点。
  加点まで止めるのは、docs / 設定の場合と違って**負いようのない証拠**であり、
  人間の判断要否を上げる材料にもならないため。
- docs / 設定のみの変更も解析可能な関数を持たないので、**その緩和を先に判定する**。
  ゲートの advisory 文言もレビュアーへの指示も、docs / 設定であればそちら側を
  返す (より具体的で正確なため)。

## 非コード変更の application domain 除外 (neco 決定 2026-08-04)

Anatomia の application domain は、製品の振る舞いを実装する業務コードの責務境界を
表す。テスト、運用マニフェスト、設定、文書、アセット、生成物は、構文解析できる
関数を含んでいても製品の業務ドメインを所有しない。これらの補助関数から
application domain を作ると、実在しない責務をカタログ等へ割り当てることになる。

- 判定: `classifyChange().codeDomainRequired` は変更種別 `kind=code` が 1 件以上ある
  ときだけ `true`。`test` / `config` / `infra` / `docs` / `asset` / `generated` だけの
  変更は `false`。
- 適用先: `needsTargetDomain` を正本として、マージゲート、レビュアープロンプト、
  `humanQuestion`、マージリスクの `missing_domain` 加点が同じ signal を共有する。
  テスト関数等が解析可能でも、対象ドメインの新設や `spec/domains` への帰属を
  要求しない。
- 再判定: レビュー後の最終差分でも変更種別を再分類する。autofix が業務コードを
  追加した場合は `codeDomainRequired=true` に戻り、通常どおり対象ドメインを要求する。
- 文言の優先順位: docs / 設定のみの変更は常に非コード変更でもあるため緩和が重なる。
  ゲートの advisory もレビュアーへの指示も **docs / 設定 → 非コード →
  解析対象なし** の順に、より具体的な方を返す (上記 2026-08-01 の方針と同じ)。
- 維持されるもの: 緩和されるのは application domain 欠如だけ。登録テスト、
  leakage、セキュリティ、complexity、アーキテクチャルール、レビュアーのその他の
  判断は従来どおり実行し、設定・テストは検証または設定する契約との整合性を審査する。

## coupling_delta の advisory 化 (neco 決定 2026-07-30)

Anatomia の一時 pr-review 解析は、`coupling_delta` の percentile 閾値と
コールグラフを解析環境から導出する。同一コミットがレビュー用 worktree では
p95=9 (14 関数が該当) となり、クリーンなローカル worktree では p95=9.9
(該当なし) となる実測があった (Concordia#3)。Anatomia 側で非決定性が解消される
までは、環境依存の判定でマージをブロックしない。結合度の増加は advisory として
記録・表示は続ける。

## warn 相当ゲートを advisory に揃える (2026-07-30)

Anatomia は各ゲートに severity を宣言している (`src/supply/gates/*.ts`):

| gate | Anatomia severity |
|---|---|
| `rule_conformance` | block |
| `duplication` | block |
| `spec_linkage` | warn (strict のみ block) |
| `coupling_delta` | warn |
| `convention_drift` | warn |

`ADVISORY_GATES` はこの **warn 集合と一致させる**。 `convention_drift` は兄弟コードから
命名の case style と共通 affix を機械的に採掘して比較するゲートで、 読んで問題ない名前でも
兄弟と違えば drift として挙がる = 提案であって欠陥ではない。 ここでブロックしていたため、
**判定を出した解析器より Revisor が厳しい**という逆転が起きていた。

Anatomia の `GateResult` は severity を載せない (Gate 定義側にしか無い) ため、 この対応は
Revisor 側で名前を再掲して維持する必要がある。 Anatomia にゲートを追加・severity を変更した
ときは `ADVISORY_GATES` も合わせて見直す。

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

## Augur 動作ブロックの扱い

Augur 台帳があるリポジトリの登録テスト結果は、ドメイン別の動作ブロックとして `ci` に残す。
`failed` は `<failed> 件の登録テストが失敗しました (<domain>)` を reason にしてブロックする。
`error` は runner 未実行であり、通過として扱わず reason にする。空 bundle の `skipped` は
`<domain> に登録テストが無い` の advisory にする。台帳が無い場合は、従来の全体スイート結果を
同じ `ci` 契約で扱う。

Augur が run record を返せない場合も、失敗した通常の登録テストと同じ `ci.output` に
stdout/stderr を保持する。既存の秘密行マスクと12KB末尾制限を適用し、成功・空bundleの
ログは保存しない。診断保存は実行結果の判定・再試行・審査ゲートを変更しない。

## 体験ブロックの扱い

動作ブロックに対応する対象 head の Augur run に `evidence` 配列が記録されていれば、審査報告と Concordia 完了通知に件数を出す。evidence が無い場合は「未確認」であり、動作ブロックの通過や `skipped` を体験確認済みとは扱わない。
