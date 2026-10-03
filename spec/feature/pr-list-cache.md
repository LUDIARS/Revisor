# PR 一覧キャッシュ

## SPEC-PR-LIST-CACHE: 一覧の整合性と出力再利用

ローカル PR 一覧は、ストアの変更トークンと一覧の判定に影響する設定が同一の間だけ、
判定済みの一覧を再利用してよい。どちらかが変わった場合は必ず一覧を再構築する。
変更トークンを取得できないストアはキャッシュしない。

HTTP 応答は、同じ判定済み一覧に対してのみ直列化済み JSON を再利用してよい。応答は
従来どおり JSON とし、認可・Host 制限・`Cache-Control: no-store` の境界を変えてはならない。

## SPEC-PR-LIST-SLIM-RECORD: 一覧の記録は解析結果を持たない

PR 記録の `anatomia` (Anatomia 差分解析の成果) は `pull_request_anatomia` テーブルに置き、
`pull_requests.record` には入れない。解析結果はリポ全関数の複雑度 (現在とベースライン) を
含み 1 件で数 MB になるため、本体に入れると一覧の SELECT・JSON.parse・HTTP 応答が
DB 全体を運ぶ (実測: 1,685 件で応答 142MB・約 2 秒、うち 91% が `anatomia`)。

- 一覧 (`GET /v1/local-prs`、`/api/local-prs`、`view=full` を含む) の記録は `anatomia` を持たない。
- 単一 PR の取得 (`GET /v1/local-prs/:id`、store の `getPullRequest`) は `anatomia` を付け戻す。
  再投入・再検証・CLI の `pr show` など、段階の成果を読む処理は単一取得を使う。
- 状態遷移やイベント追記は解析結果を書き直さない。解析結果は patch が `anatomia` を含むときだけ書く。
- `anatomia: null` (再審査の初期化) は値として保存し、キーの有無と区別する。
- 既存 database は開いたときに一度だけ本体の `anatomia` を別テーブルへ移す (meta `anatomia_split`)。
  移行後に旧コードのプロセスが本体へ書いた `anatomia` は、そのプロセスの最新の書き込みとして
  別テーブルより優先し、次の書き込みで別テーブルへ移す。
- `view=summary` は決着済み PR の終局表示のため `mergeCommitSha` を含む。

## SPEC-PR-LIST-SLIM-REPORT: 一覧の記録は審査レポート本文を持たない

審査レポート本文 (`reviewReport`) は `pull_request_review_reports` テーブルに置き、
`pull_requests.record` には版 (`reviewReportVersion`) だけを残す。本文は全件で PR 記録の
9 割超を占め (2026-10-02 実測 277 MB / 290 MB)、一覧だけでなくリポジトリ一覧・Test Workflow・
自動マージのスイープが毎回全件を JSON.parse して 1 回 4 秒前後イベントループを止めていた。

- store の一覧 (`listPullRequests`) の記録は `reviewReport` を持たず `reviewReportVersion` を持つ。
- 単一 PR の取得 (`getPullRequest`) は `reviewReport` を付け戻し、`reviewReportVersion` は出さない
  (完全な記録の形は分離前と同じ)。完了通知・再審査・詳細 API は単一取得を使う。
- 状態遷移やイベント追記は本文を書き直さない。本文は patch が `reviewReport` を含むときだけ書く。
  `reviewReport: null` は値として保存する。
- 一覧 API の `include=reviewReport` は、絞り込んだ PR の本文だけを別テーブルから読んで付ける。
- 既存 database は開いたときに一度だけ本体の本文を別テーブルへ移す (meta `review_report_split`)。
  移行は id 順に 50 件ずつの書き込みトランザクションに分け、間で他プロセスを通す
  (2026-10-03 実測: 実データ 624 件・14 バッチで計 43 秒、1 バッチの最長 5 秒)。
  旧コードのプロセスが本体へ書いた本文は、次の書き込みまで別テーブルより優先する。

## SPEC-REVIEW-QUEUE-STATE-PROJECTION: キュー状態は審査の入力を運ばない

審査 job の `request` は審査の入力一式 (前回の PR 記録を含む) で 1 件数百 KB になる
(2026-10-03 実測: 200 件で `/v1/review-work` が 67 MB)。

- `JobStore.state()` の各 job は表示用の射影で、`request` はリポジトリ・番号・レーン・PR id だけ。
  射影は SQLite の JSON 関数で取り出し、入力本体を JSON.parse しない。
- 入力が要る処理 (worker の確保 `claimNext`、`get`) は従来どおり完全な job を返す。
- 投入・確保・回収など条件で絞れる操作は、SQL で対象行を選んでから parse する。
