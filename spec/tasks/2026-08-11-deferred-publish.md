---
task: deferred-publish
project: Revisor
kind: 実装
status: done
created: 2026-08-11
source_session: lictor-0f2fc185-201a-4e66-9839-cda9c29e43ab
memoria_task_id: null
actio_task_id: null
memory_links: []
---

# 保留付きローカルマージ (GitHub へ push しないで完結する publish)

## 目的

`spec/plan/deferred-publish-design.md` の実装。 GitHub App が入っていない org
(MELPOT/KuzuSurvivors) では publish 段の `GET /repos/.../installation → 404` で
マージ全体が止まる。 GitHub へ届かない状況でもローカルのマージは完結させ、
push / Release 作成だけを保留 (pending) として記録し、 後から一括で送れるようにする。

## 完了条件

- installation 404 のときエラーにせず保留経路へ落ちる。 404 以外 (認証失敗・500・
  ネットワーク断) は従来どおり失敗する
- `revisor pr merge <n> --defer-push` で保留を明示できる。 このとき GitHub クライアントを
  組み立てず、 資格情報の復号も行わない
- 保留経路でもローカルは通常マージと同一の終局状態 (squash コミット・base 前進・
  ローカルリリースタグ) になる
- 保留は `refs/revisor/pending-publish/<sha256(localPrId)>` として merge repository に残り、
  PR 記録は `merged` + `publication: "deferred"` になる
- `revisor publish-pending [--repository <owner/name>] [--json]` が保留分を後送し、
  成功したものだけ ref を消して `publication: "published"` へ引き上げる。 到達不能は
  skip して残す (エラーにしない)
- GitHub App が正常に使えるリポジトリのマージ経路は変わらない (既存テスト green)

## スコープ (編集可ディレクトリ)

- `src/publication-state.mjs` (新規) — published / deferred の 2 状態
- `src/github-reachability.mjs` (新規) — installation 404 の判定と GitHub 到達の解決
- `src/release-preparation.mjs` (新規) — publish のうち GitHub へ触れない部分 (タグ選定・
  Release Notes・漏洩スキャン・ローカルタグ)
- `src/deferred-publication.mjs` (新規) — 保留経路の publish
- `src/pending-publish.mjs` (新規) — 保留 ref の記録・列挙・削除
- `src/publish-pending.mjs` (新規) — 保留分の一括後送
- `src/release-publisher.mjs` / `src/local-merge.mjs` / `src/local-pr-service.mjs` /
  `src/local-pr-commands.mjs` / `src/cli.mjs` / `src/github-app.mjs` / `src/state-store.mjs`
- `test/deferred-publish.test.mjs` (新規)

## 結果 (2026-08-11)

- publish の GitHub 到達部を `resolveGitHubAccess` へ分離した。 `installationToken` が
  installation 404 を返したときだけ保留へ落ち、 それ以外の失敗はそのまま投げる。
  判定は GitHub API エラーへ添えた `status` / `apiPath` で行い、 文言照合には頼らない。
- タグ選定から漏洩スキャン・ローカルタグ作成までを `prepareRelease` として共有した。
  通常経路と保留経路が同じ選定・同じゲートを通るので、 後日の後送でも同じタグになる。
- 保留経路は `.revisor-version` を書き戻さない。 版数の正本を「公開済み」へ進めると
  後送が同じ版を publish できなくなるため。
- 保留 ref は base 前進の**前**に張る。 先に base が動いて記録前に落ちると、
  「ローカルには入っているが保留の記録が無い」= 永久に送られない変更になる。
- `refs/revisor/prepared/*` (中断復旧) とは名前空間が別で、 互いに干渉しない。

## 対象外

- UI (ui-release-page) での保留表示。 記録に `publication` / `deferredPublishReason` を
  持たせるところまで。
- HTTP マージ経路への `--defer-push` 相当の口。 明示保留は CLI 限定 (自動保留は経路を
  問わず効く)。
