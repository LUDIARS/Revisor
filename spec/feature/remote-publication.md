---
type: feature
title: "remote-publication — reviewed main and operator-triggered Release publication"
description: "審査済みlocal PRはmainだけを公開する。major/minor tagとGitHub ReleaseはReleasesタブの明示操作で現在のbaseを即時公開し、feature branchやhosted PRは公開しない。"
service: revisor
domain: remote-publication
tags:
  - github-app
  - release
  - versioning
  - local-pr
status: implemented
related:
  - ../architecture.md
  - ./pr-lifecycle.md
  - ./security-scan.md
updated: 2026-08-23
---

# remote-publication — reviewed main and operator-triggered Release publication

## Responsibility

Revisor is the only owner of publishing reviewed repository refs and Releases.
An explicitly approved history replacement is handled by
[Approved push handoff](approved-push-handoff.md), through the existing push CLI,
fresh Cc WARNING approval and an immutable single-attempt ledger. Ordinary PR merge
and Release publication retain their fast-forward and tag-collision protections.
An ordinary local-PR merge:

1. creates the reviewed squash commit;
2. runs the final security scan over that exact commit;
3. pushes only the base branch with the Revisor GitHub App;
4. advances the local base branch and marks the local PR merged.

Ordinary merges do not assign a version, increment patch, create a tag, or
create a GitHub Release.

The Releases tab is an explicit transaction for a major or minor Release of the
currently checked-out registered base HEAD:

1. require valid managed local version state;
2. calculate exactly the next major or minor boundary with patch zero;
3. require confirmation and the version observed when the form was opened;
4. scan the operator-authored Release Notes for credential leakage;
5. create an annotated tag on current base HEAD;
6. atomically push base plus tag through the GitHub App;
7. create the GitHub Release and only then update local version state.

公開先の base ブランチは既に GitHub 側に存在していることが前提で、Revisor は base
を早送りするだけで作らない。例外は **ref を 1 つも持たない空のリポジトリ**への初回公開
だけで、この場合は動かす履歴が無いので base ブランチを新規に作る (tag があれば同じ
push に載せる)。ref を持つリポジトリで base だけが見つからないのは削除・改名の兆候
なので、従来どおり `GitHub branch '<base>' does not exist.` で止める。

Manual Release and PR merge share one publication coordinator. They cannot
select a version or move base/tag refs concurrently. A stale or duplicate
request fails instead of silently publishing a different version.

Feature branches, hosted pull requests, GitHub Actions dispatch, repository
creation, branch-protection administration, and arbitrary remote Git commands
are outside this domain. The managed pre-push hook rejects direct base/tag and
feature-branch pushes; only Revisor marks publication refs as owned.

The former Castra-owned `dw` GitHub command has no independent runtime
responsibility. Revisor exposes `dw` as a compatibility alias for its CLI while
installations migrate. Managed startup remains Excubitor-owned.

## Version contract

Release versions are canonical annotated tags `vMAJOR.MINOR.PATCH`. Every
repository tracks `.revisor-version`; its committed bootstrap value is
`uninitialized`. Registration and publication preflight idempotently mark an
existing tracked path `skip-worktree`, after which it is machine-local
operational state. Local PRs may not add, edit, or remove this path.

A legacy repository without the file remains visible as missing. The Releases
page initialization action requires its base branch to be checked out, refuses
an untracked collision, commits only the bootstrap path, then records the chosen
initial version as skip-worktree state.

Leaving `.revisor-version` uninitialized or equal to the latest Release is the
ordinary no-Release state. Patch Releases are not created. Major/minor actions
calculate only `v(MAJOR+1).0.0` or `vMAJOR.(MINOR+1).0`; prerelease labels and
non-canonical versions do not participate.

The Releases tab is the primary operator surface. For compatibility,
`revisor version set` may explicitly stage the next major/minor boundary for
the next reviewed merge; an unchanged version never produces a Release.

GitHub Release bodies are the sole release-note source of truth. Major/minor
Release Notes contain the operator-authored title and notes, exact version
transition, current base commit, and the previous-tag comparison when present.
They are not copied to repository files or a Wiki.

There are no LTS or maintenance lines. Older immutable tags and Releases are
historical records, not separately operated streams. A product may project the
released value at build/runtime but must not maintain a second release line.

## Notifications and release-note API

`GET /v1/repositories/:id/changes?from=&to=` exposes the registered repository's
commit range, merged local PR metadata, release-note-shaped Markdown, and a
sanitized notification summary. Omitting `from` selects the latest local Release
tag. The API never returns webhook secrets, raw local paths, or unsafe mentions.

Repository registration may declare `notify: { release: ["discord:name",
"concordia"], merged: ["slack:name"] }`; both lists default to empty. `release`
is sent only after a GitHub Release was created. A `concordia` release target
resolves the optional Concordia loopback URL from the Excubitor catalog and
POSTs `/v1/events/release-published` with `{repository, kind, tag, previousTag,
version, title, notice, releaseUrl, publishedAt}`. It uses a three-second
timeout; unavailable Concordia is recorded as an unsent target and never
changes the completed Release result. `concordia` is deliberately ignored for
`merged`: merged notices remain Discord/Slack webhook-only. `merged` is optional
and off by default, for owners who want to know that the repository changed
before deployment. Delivery is best-effort and never changes a successful
Release or merge result.

`revisor secret set webhook.<name> <url>` encrypts named Discord or Slack URLs.
The legacy instance-wide `discordWebhookUrl` remains readable as `webhook.discord`
for compatibility. Slack delivery accepts only `hooks.slack.com/services` URLs,
uses `{text}`, neutralizes channel/user mentions, and times out after three seconds.

## Local API / CLI からの Release

同一ホストの自動化は、loopback 限定の `GET /v1/repositories/:id/release-state`
で登録 checkout の local version、最新 Release tag、次の major/minor tag、および未公開
commit 数を読む。`:id` は store record id と `owner/name` のいずれでも指定できる。

`POST /v1/repositories/:id/releases` は `{kind, expectedVersion, title, notes,
confirmed:true}` を受け、UI と同じ `validateManualRelease` と `ReleaseService.release`
を経由する。したがって publication coordinator により local PR merge と直列化され、
patch Release や UI とは異なる公開経路を作らない。期待 version の不一致、未初期化
version、base 以外の checkout は 409、入力不正は 400 とする。

`revisor release <owner/name> --kind major|minor --title <text> --notes-file <path>
--expected-version <version> [--json]` はこの local API の HTTP client であり、notes は
UTF-8 file からだけ読む。CLI は `confirmed:true` を送信し、Release の権限判断・公開処理を
複製しない。

## Authentication and data boundary

The GitHub App id and PEM private key are encrypted in `revisor.config.json`.
The private key and short-lived installation token are never returned by an API,
placed in argv, a remote URL, a log, Release Notes, or state. Authenticated Git
receives its HTTP header through process environment configuration.

Release Notes pass high-confidence credential patterns before the API call. A
finding reports only rule, field name, and line; the matched value is never
included in the error or persisted.

The repository-scoped installation token requests `contents:write`.
`workflows:write` is requested only when already granted; publication containing
workflow changes otherwise fails closed at GitHub.

## Consistency and recovery

The remote base must equal or be an ancestor of the local source-of-truth base,
unless it already equals a prepared squash commit from a retry. Revisor never
force pushes over an independently moved remote base.

An independently moved remote base is first repaired automatically
(2026-08-08): `src/base-reconcile.mjs` fetches the remote base and brings it
into the local base — fast-forward when only GitHub is ahead, a clean merge
commit when the histories diverged — then the squash merge is retried once on
the advanced base (the stale prepared merge from the failed attempt is
discarded first, together with any local release tag attached to it). Only a
conflicting divergence, or a base that moves again right after reconciliation,
still stops with the manual-reconcile error. The repair only ever pulls remote
commits in; local history is never rewritten.

Ordinary publication sends only the base ref. A manual Release sends base and
annotated tag in one atomic push; the Release API call follows after its target
is reachable. A private `refs/revisor/prepared/*` ref keeps tagged and untagged
prepared merge commits reachable until local base advancement finishes. Retry
reuses the same `Revisor-Local-PR` commit and completes publication idempotently.

The managed pre-push guard scans the remote base update. A tag ref is allowed
during a Release but never substitutes for the base scan.

## 元 hook の解決

登録時は環境から注入された `GIT_CONFIG_*` を除いて hook 設定を読み、Revisor 管理
directory が repo-local `core.hooksPath` の場合は global `core.hooksPath` を元として使う。
一時directory または `concordia-session-hooks` は元 hook として拒否する。実体かつ実行可能な
元 hook だけを proxy し、再導入時には元にない proxy を削除する。`repo notify` と
`PATCH /v1/repositories/:id/notify` は hook を変更せず通知先だけを更新する。

CLI (`src/cli.mjs`) は起動時に、Concordia セッションが shell へ注入した hook 設定
(`GIT_CONFIG_*` の `core.hooksPath` が `concordia-session-hooks` を指すスロットと
`CONCORDIA_SESSION_HOOK_*`) を `process.env` から外す (`src/session-hook-env.mjs`)。他の
`GIT_CONFIG_*` スロットは詰め直して保つ。これにより CLI 自身の git、hook 導入、CLI が起動する
ワーカーがセッション用ラッパーを経由しなくなる。

Missing App credentials, installation access, permissions, remote divergence,
tag collision, push failure, and Release failure fail explicitly. The error
remains visible until publication succeeds. There is no PAT, anonymous, or
local-only fallback.
