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
