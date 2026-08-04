---
type: feature
title: "remote-publication — reviewed main/tag/Release publication"
description: "審査済みlocal PRのsquash commitへSemVer tagを付け、Revisor GitHub Appでbaseとtagをatomic pushし、Release Notesを記録してからローカルbaseとPR状態を確定する。feature branchやhosted PRは公開しない。"
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
updated: 2026-08-04
---

# remote-publication — reviewed main/tag/Release publication

## Responsibility

Revisor is the only owner of publishing a reviewed local PR. A successful
merge is one transaction from the operator's point of view:

1. create the reviewed squash commit;
2. run the final security scan over that exact commit;
3. assign the next stable semantic version tag;
4. atomically push the base branch and annotated tag with the Revisor GitHub App;
5. create an idempotent GitHub Release whose notes come from the local PR;
6. advance the local base branch and mark the local PR merged.

Feature branches, hosted pull requests, GitHub Actions dispatch, repository
creation, branch-protection administration, and arbitrary remote Git commands
are outside this domain. GitHub is a publication ledger for the released base
commit, version tag, and release notes.
The managed pre-push hook rejects direct base/tag pushes as well as
feature-branch pushes; only the Revisor publication process marks the release
refs as owned.

The former Castra-owned `dw` GitHub command has no independent runtime
responsibility after this integration. Revisor exposes `dw` as a compatibility
alias for its own CLI while installations migrate; both names execute the same
code and use the same encrypted Revisor configuration. `dw ui` maps to the
Revisor UI, while managed startup remains Excubitor-owned.

## Version contract

The release version is the canonical annotated tag `vMAJOR.MINOR.PATCH`.
Every repository tracks `.revisor-version`; its committed bootstrap value is
`uninitialized`. Registration and the publication preflight idempotently mark
that tracked path `skip-worktree`, after which it is machine-local operational
state and never enters a reviewed diff or push. The preflight lets repositories
registered before this rule migrate without a second registration.
Any local PR that adds, edits, or removes this path is rejected before review
and checked again before merge.

There is no universal initial version. Before a repository's first publication,
the operator specifies it separately with
`revisor version set MAJOR.MINOR.PATCH --repo <path>`. The first merge uses that
exact value. Afterward, a normal merge requires the file to equal the latest
released tag and increments patch by one. Revisor writes the successful version
back to the local file only after base/tag push and Release creation succeed.

A product declares a major or minor transition by setting the local file to the
next `v(MAJOR+1).0.0` or `vMAJOR.(MINOR+1).0` value before merge. Revisor uses
that exact value for the release tag. A manually advanced patch value is
rejected because patch numbering belongs to Revisor. Pre-release labels and
non-canonical versions do not participate.

There are no LTS or maintenance lines. Only the registered base branch and its
latest version advance; older immutable tags and Releases are historical
records, not separately operated release streams.

The tag-linked GitHub Release is the canonical release-note location. Patch
Releases contain the local PR summary. Major and minor Releases additionally
record the exact version transition and link GitHub's comparison from the
previous release tag. Revisor does not duplicate release notes into GitHub
Wiki: a wiki is mutable long-form documentation in a separate `.wiki.git`
repository, which would create a second source of truth and a second publication
transaction outside the reviewed base commit and release tag.

The file is deliberately Revisor-specific rather than a language package
version. Its `skip-worktree` update is local metadata, while GitHub records the
same value as the immutable tag and Release. A product may project that value
at build/runtime, but must not maintain a second independent release line.

## Authentication and data boundary

The GitHub App id and PEM private key are encrypted in `revisor.config.json`
with Revisor's existing local key. The private key and short-lived installation
token are never returned by an API, placed in an argv, remote URL, log, release
note, or state record. Authenticated Git receives its HTTP header through
process environment configuration.
The reader also accepts Revisor's earlier `githubAppId` plus encrypted
`githubAppPrivateKey` shape, so an installation configured before the local-PR
redesign can publish without exposing or re-entering its private key. The next
explicit save uses the unified credential blob.
Release Notes pass the same high-confidence credential patterns before the API
call. A finding reports only rule, field name, and line; the matched value is
never included in the error or persisted.

The installation token is repository-scoped and requests `contents:write`.
`workflows:write` is requested only when the installation already grants it;
a release containing workflow changes otherwise fails closed at GitHub.

## Consistency and recovery

The remote base must equal or be an ancestor of the local source-of-truth base,
unless it already equals the prepared squash commit from a retry. This permits
the authoritative local `main` to publish commits accumulated while the remote
was behind. Revisor never force pushes over an independently moved remote base.

The base branch and annotated tag are sent by one atomic Git push. The Release
API call follows because GitHub cannot create the release before its target is
reachable. A failure after that push leaves the local base unadvanced and the
PR open. The local annotated tag keeps the prepared commit reachable; retry
finds its `Revisor-Local-PR` trailer, reuses its version, completes the missing
Release call idempotently, and only then advances the local base and state.
The managed pre-push guard scans the update by its remote base ref, including
the detached commit refspec Revisor uses before advancing the local branch;
the tag ref is allowed but never substitutes for the base scan.

Missing or undecryptable App credentials, installation access, permissions,
remote divergence, tag collision, push failure, and Release failure all fail
the merge explicitly. The error stays on the open PR for Cc and the decision
board to read until publication succeeds. There is no PAT, anonymous, or
local-only fallback.
