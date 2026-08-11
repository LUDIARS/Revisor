# 設計書: 保留付きローカルマージ (GitHub へ push しないで完結する publish)

- 作成: 2026-08-11 / Claude Fable 5 (設計担当)
- 実装担当: Claude Opus 5 (delegation)。worktree `E:/Document/Ars/.wt-Revisor-defer-publish`
  (checkout branch `feat/deferred-publish` のまま)。実装完了後は日本語 conventional
  commit。リモート送信・PR 提出は設計側が行う。
- neco 指示 (2026-08-11): 「push しないで保留できるように」
- 背景: MELPOT/KuzuSurvivors の local PR #433 マージが publish 段の
  `GET /repos/MELPOT/KuzuSurvivors/installation → 404` (GitHub App 未インストール org)
  で失敗する。GitHub へ届かない状況でも**ローカルのマージは完結**させ、GitHub への
  push / Release 作成だけを**保留 (pending)** として記録し、後から一括実行したい。

## 1. 仕様

### 1.1 保留判定

`publishMergedPullRequest` (src/release-publisher.mjs) の GitHub 到達部を分離する:

- **自動保留**: `installationToken` が installation 404 (App 未インストール) を返す場合、
  エラーにせず**保留経路**へ落ちる。404 以外 (認証失敗・ネットワーク等) は従来どおり
  エラー (黙って保留にすると障害を隠すため)。
- **明示保留**: CLI `revisor pr merge <n> --defer-push` でも保留経路を強制できる。

### 1.2 保留経路で行うこと / 行わないこと

行う:
- squash マージコミット作成・`advanceLocalBranch` (ローカル base 前進)・
  ローカルリリースタグ (`createLocalReleaseTag`、タグ選定は従来ロジック) —
  つまり**ローカル側は通常マージと同一の終局状態**
- 保留の記録: `refs/revisor/pending-publish/<sha256(localPrId)>` を merge commit に
  張り、PR 状態は `merged` + `publication: "deferred"` (state に列を追加)
- 標準出力/ログに「GitHub publish を保留した」ことを明示

行わない:
- `pushPublishedCommit` (GitHub push)・GitHub Release 作成・remote tags 照会

### 1.3 後日の一括 publish

```
revisor publish-pending [--repository <owner/name>] [--json]
```

- `refs/revisor/pending-publish/*` を列挙し、GitHub App が到達可能になったものから
  従来の publish (push + Release) を実行 → 成功したら pending ref を削除し
  `publication: "published"` へ更新。
- 到達不能のものは skip して残す (エラーにしない)。件数と結果を表で出す。

### 1.4 既存挙動の不変条件

- GitHub App が正常に使えるリポジトリのマージ経路は 1 bit も変えない
  (defer 指定なし + installation 成功 → 従来コードパス)。
- prepared merge の復旧経路 (`findPreparedMerge`) と保留 ref は独立に共存する。
- `.revisor-version` ゲート・セキュリティスキャン・審査状態ゲートは保留でも従来どおり。

## 2. テスト (既存テストの流儀に合わせる)

1. installation 404 を返す fake client → マージ成功・ローカル main 前進・
   pending ref が存在・PR state が merged/deferred。
2. `--defer-push` 明示 → GitHub client を一切呼ばずに同上。
3. 404 以外のエラー (500) → 従来どおり失敗し、ローカル main は前進しない。
4. `publish-pending`: fake client 成功 → push/Release が呼ばれ pending ref 消滅。
   到達不能 → skip して ref 残存。
5. 既存の publish 系テストが全て green (挙動不変)。

## 3. 完了条件

- `npm test` (または既存のテスト実行方法) green。新規テスト §2 を含む。
- 変更ファイル一覧とコミット SHA を最終報告 (ASCII でよい)。
- スコープ外: UI (ui-release-page) の表示対応は最小限 (壊れない程度) でよい。

## 4. 禁止

リモート送信 / PR 作成 / 既存ゲート・審査ロジックの変更 / スコープ外リファクタ
