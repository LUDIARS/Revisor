---
task: "c-7-undefined-reviewreport"
project: "revisor"
kind: "実装"
created: "2026-09-21"
---
# C-7 の述語が undefined の reviewReport を違反扱いにしないようにする

## 目的

`contracts/update-review-report.contract.mjs` の事前条件が `report === null` しか通さないため、
`reviewReport` 項目を持たない旧 PR レコードを渡す正当な呼び出し (`LocalPrReporter.running` /
`reviewStageCompleted` / `#recordCiProgress`) が契約違反として記録されていた。
`typeof null === "object"` なので `=== null` の分岐は元から null を拾えており、実際に弾かれて
いたのは `undefined` だけである。`updateReviewReport` 本体は未設定の報告を想定済みで
(`report?.entries`、`attemptId ?? report?.attemptId`)、述語のメッセージも "optional report" と
書いている。述語だけが本体と食い違っていた。

契約の mode は `observe` のため審査・マージの判定は変わらないが、契約ログの違反行が正当な
進捗記録で埋まり、本物の違反が読めなくなる。これを解消する。

## 受け入れ条件

- C-7 updateReviewReport(report, entry): reviewReport 未設定の呼び出しも受け入れ、attempt ごとに安定 id の安全なレビュー報告を置換記録する

## 完了条件

- `contracts/update-review-report.contract.mjs` の事前条件が `null` と `undefined` の両方を
  任意の報告として受け入れ、`entry` 側の検査は緩めない。
- `augur.contracts.json` の C-7 の受け入れ条件文が未設定の報告を受け入れる契約として読める。
- `test/review-report.test.mjs` に、未設定の報告からの進捗記録が契約ログへ違反ではなく
  観測として残る回帰テストがある。
- `spec/feature/complete-discord-review-report.md` に未設定の報告の扱いを記す。
- `augur contracts lint` が本変更由来の指摘を出さない。

## スコープ (編集可ディレクトリ)

- contracts
- test
- spec
