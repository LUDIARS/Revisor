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
updated: 2026-08-05
---

# remote-publication — reviewed main and operator-triggered Release publication

## Responsibility

Revisor is the only owner of publishing reviewed repository refs and Releases.
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

Ordinary publication sends only the base ref. A manual Release sends base and
annotated tag in one atomic push; the Release API call follows after its target
is reachable. A private `refs/revisor/prepared/*` ref keeps tagged and untagged
prepared merge commits reachable until local base advancement finishes. Retry
reuses the same `Revisor-Local-PR` commit and completes publication idempotently.

The managed pre-push guard scans the remote base update. A tag ref is allowed
during a Release but never substitutes for the base scan.

Missing App credentials, installation access, permissions, remote divergence,
tag collision, push failure, and Release failure fail explicitly. The error
remains visible until publication succeeds. There is no PAT, anonymous, or
local-only fallback.
