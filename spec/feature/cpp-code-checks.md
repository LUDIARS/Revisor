---
type: feature
title: C++ code checks — Anatomia code-check as a registered check
description: Judge the C++ lines a PR wrote with Anatomia's deterministic code-level checks.
service: revisor
domain: review-gate
status: implemented
---

# C++ code checks

検査の本体 (規則・しきい値・既知の限界) の正本は Anatomia の
`spec/feature/code-checks.md` (`anatomia code-check`)。Revisor はそれを PR 審査の
登録チェックとして呼び、「この PR が書いた行に止めるべき指摘があるか」だけを判定する。
LLM・ネットワークは使わない。

Actio task: `actio:94697901-b4b9-4fd9-bc8b-cda614ab1b61` (Anatomia 側は `actio:b4c334d4-f844-4e21-a64f-96f02316f15b`。検知/ツールは Anatomia、
テスト的実装は Revisor に置く、という人間の指示による分担)。

## RV-CPP-CODE-CHECKS-01: 変更された C++ ファイルだけを Anatomia で検査する

`src/cpp-code-checks/run.mjs` が `changedSourcePaths(worktree, mergeBase)` (Praesidium と
同じ変更集合: merge base からの追加・変更と未追跡の新規。削除は除く) のうち C++ ソース
(`.cc .cpp .cxx .c++ .h .hh .hpp .hxx .h++ .inl .ipp`。`.c` は Anatomia 同様に対象外) を
`node <anatomiaFolder>/bin/anatomia.mjs code-check --repo <worktree> --files-from - --json --fail-on none`
へ標準入力で渡す。合否は Revisor が決めるので Anatomia 側では落とさない (`--fail-on none`)。

- C++ の変更が無い PR では結果行を作らない (検査対象が無い)。
- **fail closed**: C++ の変更がある PR で、Anatomia を解決できない (`anatomiaFolder` 未設定を含む)・
  変更集合や書いた行を git から取れない・CLI が exit 0 で version 1 のレポートを返さない場合は
  `error` (exit 2) とし、通さない。理由にはローカルパスや例外文を残さない。
  Anatomia に `code-check` が無い (古い checkout の) ときも同じく `error`。省略 (skipped) にはしない
  (2026-11-11 に暫定で入れた skipped は、neco「skip は良くない」で外した)。`anatomiaFolder` の checkout は
  `code-check` を持つ版 (Anatomia `0ad6d73` 以降) に保ち、`dist/` を作り直しておくこと。
- merge base が無いときは、リポジトリに C++ が無ければ対象外、あれば `error`。

## RV-CPP-CODE-CHECKS-02: PR が書いた行だけで判定する

`src/cpp-code-checks/changed-lines.mjs` が `git diff -U0 --no-renames --diff-filter=d <mergeBase> -- <files>`
の hunk ヘッダ (`+start,count`) から、ファイルごとの書いた行範囲を作る。削除だけの hunk は範囲を
持たない。diff に現れない変更ファイル (未追跡の新規) は全行を書いた行とする。

- 書いた行の **error** 指摘 (Anatomia の `memory/*` 規則が既定で error) が 1 件でもあれば `failed`。
- 書いた行の warning / info は `passed` のまま `output` に載せる参考情報。
- 書いた行の外の指摘 (触ったファイルに元からある問題) は件数 (`codeChecks.outsideWrittenLines`)
  だけ残し、判定にも出力にも使わない。既存コードの負債で、それを書いていない PR を止めないため。
- 関数単位の指摘 (複雑度など) は関数宣言の行に付くので、本体だけを変えた PR では拾われないことがある。
  これらは warning 既定で判定に使わないため、合否は変わらない。

結果行: `{ name: "C++ code checks (Anatomia)", status, exitCode, durationMs, codeChecks: { files,
writtenFindings: { error, warning, info }, outsideWrittenLines, parseErrors }, reason?, output? }`。
`output.text` は error を先頭に `file:line: severity: message [rule]` を最大 8000 文字。

## RV-CPP-CODE-CHECKS-03: 登録チェックの並び

`src/praesidium-ci.mjs` の事前検査が通った後、`src/cpp-code-check-ci.mjs` が C++ の結果行を
登録テストの前に置く。C++ が `failed` でも登録テストは実行する (どちらも審査の証拠であり、
`testsPassed` はどれか 1 行でも passed/skipped 以外なら段階を不合格にする)。
登録テストの全経路 (通常・autofix・plan 変更の再検証・最終検証) に `anatomiaFolder` を渡す。

## 検証

`test/cpp-code-checks.test.mjs`: hunk 解析、C++ だけを標準入力で渡すこと、書いた行の error だけで
落ちること、C++ 変更なしで行を作らないこと、Anatomia 解決失敗・git 失敗・不正レポートで
`error` になること、merge base 不明時の扱い、結果行の順序と後続テストの継続。
