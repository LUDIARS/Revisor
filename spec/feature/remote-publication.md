---
type: feature
title: "remote-publication — reviewed main and human-selected Release publication"
description: "審査済みlocal PRのsquash commitをRevisor GitHub Appでmainへ公開する。tagとGitHub Releaseは人間がmajor/minor更新を指定した時だけ作成し、feature branchやhosted PRは公開しない。"
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

# remote-publication — reviewed main and human-selected Release publication

## Responsibility

Revisor is the only owner of publishing a reviewed local PR. A successful
ordinary merge is one transaction from the operator's point of view:

1. create the reviewed squash commit;
2. run the final security scan over that exact commit;
3. push the base branch with the Revisor GitHub App;
4. advance the local base branch and mark the local PR merged.

When a human has explicitly selected the next major or minor version, steps 3
and 4 additionally create an annotated tag, push base plus tag atomically, and
create the corresponding GitHub Release before local state is finalized.

Feature branches, hosted pull requests, GitHub Actions dispatch, repository
creation, branch-protection administration, and arbitrary remote Git commands
are outside this domain. The managed pre-push hook rejects direct base/tag
pushes and feature-branch pushes; only Revisor marks publication refs as owned.

The former Castra-owned `dw` GitHub command has no independent runtime
responsibility after this integration. Revisor exposes `dw` as a compatibility
alias for its own CLI while installations migrate; both names execute the same
code and use the same encrypted Revisor configuration. `dw ui` maps to the
Revisor UI, while managed startup remains Excubitor-owned.

## Version and Release contract

Release versions are canonical annotated tags `vMAJOR.MINOR.PATCH`. Every
repository tracks `.revisor-version`; its committed bootstrap value is
`uninitialized`. Registration and publication preflight idempotently mark this
path `skip-worktree`, after which it is machine-local operational state. A local
PR that adds, edits, or removes the path is rejected before review and checked
again before merge.

An ordinary merge does not assign a version, increment patch, create a tag, or
create a GitHub Release. Leaving `.revisor-version` as `uninitialized`, or equal
to the latest released tag, is explicit no-Release state.

A human selects Release timing with:

```text
revisor version set MAJOR.MINOR.PATCH --repo <path>
```

With no existing Release tag, the next merge creates that exact initial tag and
GitHub Release. Its Release Notes body is empty. After the initial Release, only
the sequential next `v(MAJOR+1).0.0` or `vMAJOR.(MINOR+1).0` is accepted. A
manually advanced patch is rejected because patch Releases are not part of this
workflow. Pre-release labels and non-canonical versions do not participate.

For every later major/minor Release, the GitHub Release body records the exact
version transition, every commit subject and SHA since the previous Release tag,
and GitHub's comparison link. These notes are generated only at Release time;
they are not copied into repository files, pull requests, or a Wiki. GitHub
Release bodies are the sole release-note source of truth.

There are no LTS or maintenance lines. Older immutable tags and Releases are
historical records, not separately operated release streams.

The local file is deliberately Revisor-specific rather than a language package
version. A product may project the released value at build/runtime, but must not
maintain a second independent release line.

## Authentication and data boundary

The GitHub App id and PEM private key are encrypted in `revisor.config.json`
with Revisor's existing local key. The private key and short-lived installation
token are never returned by an API, placed in argv, a remote URL, a log, Release
Notes, or state. Authenticated Git receives its HTTP header through process
environment configuration.

The reader also accepts Revisor's earlier `githubAppId` plus encrypted
`githubAppPrivateKey` shape. The next explicit save uses the unified credential
blob. Release Notes pass the same high-confidence credential patterns before the
API call. A finding reports only rule, field name, and line; the matched value is
never included in the error or persisted.

The installation token is repository-scoped and requests `contents:write`.
`workflows:write` is requested only when the installation already grants it; a
publication containing workflow changes otherwise fails closed at GitHub.

## Consistency and recovery

The remote base must equal or be an ancestor of the local source-of-truth base,
unless it already equals the prepared squash commit from a retry. Revisor never
force pushes over an independently moved remote base.

Ordinary publication sends only the base ref. A human-selected Release sends the
base and annotated tag in one atomic Git push; the Release API call follows once
its target is reachable. A private `refs/revisor/prepared/*` recovery ref keeps
both tagged and untagged prepared commits reachable until local base advancement
finishes. If the process stops, retry reuses the same `Revisor-Local-PR` commit,
completes the missing push or Release call idempotently, then advances local base
and removes the recovery ref.

The managed pre-push guard scans the update by its remote base ref, including the
detached commit refspec Revisor uses before advancing the local branch. A tag ref
is allowed during a Release but never substitutes for the base scan.

Missing or undecryptable App credentials, installation access, permissions,
remote divergence, tag collision, push failure, and Release failure all fail the
merge explicitly. The error stays on the open PR for Cc and the decision board
to read until publication succeeds. There is no PAT, anonymous, or local-only
fallback.
