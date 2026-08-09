# Local PR の内容不足でレビューを開始してしまう

## Evidence

- 2026-08-08 に、Cc / Revisor 経由で登録された local PR の body が雑で作業内容を判断できないと報告された。
- `validatePullRequestSubmission` は body を空文字も含めて受け入れ、`LocalPrService.submitPullRequest` がそのままレビューキューへ入れていた。
- Revisor UI では body がメタデータの一行として表示され、独立した `PR内容` 項目ではなかった。

## Cause

PR 内容の構造と記入言語を API 契約にしていなかったため、提出元が空・英語・コミット件名だけの body を送っても、テスト開始まで進めた。

## Fix

- local PR の title と `## 実装内容` / `## 受け入れ条件` を必須の日本語契約として検証する。
- 検証は `LocalPrService.submitPullRequest` の前に行い、不備のある要求を 400 で reject してキュー投入を防ぐ。
- UI は body を `PR内容` として独立表示し、作成フォームも同じ構造を案内する。

## Regression expectation

- 日本語 title と具体的な実装内容・受け入れ条件を持つ PR だけが審査へ進む。
- 内容不足の PR はレビューサービスへ到達せず、テストを開始しない。
