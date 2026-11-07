---
type: feature
title: C++ dependency vulnerabilities — OSV lookup as a registered check
description: Inventory the C++ libraries a repository pins and check the ones a PR adds or re-pins against OSV.
service: revisor
domain: review-gate
status: implemented
---

# C++ dependency vulnerabilities

Actio task: `actio:fb992b39-aad8-42c3-a607-cfc893aa3db0`. Human instruction (2026-11-07):
「Rv の脆弱性診断に C++ のライブラリも追加」, and the choice to query the OSV API.

Neither existing vulnerability pass covered third-party C++ code: codex-security reviews the diff,
and Praesidium (RV-PRAESIDIUM-03) treats host libraries as trusted toolchain input and makes no claim
about third-party sources. This check identifies the C++ libraries a repository pins and asks OSV
(osv.dev, Google's open vulnerability database) whether those revisions carry known vulnerabilities.
It is separate from Praesidium because Praesidium is offline by design and this check is not.

## RV-NATIVE-DEPS-01: Deterministic inventory

`src/native-deps/inventory.mjs` builds the inventory of one tree — the review worktree (tracked and
nonignored new files) and, separately, the merge base commit (`tree-source.mjs`). A tree without any
C/C++ source has no inventory; a JavaScript project's git submodules are not C++ libraries.

| Source | Record |
|---|---|
| `FetchContent_Declare` / `ExternalProject_Add` in `CMakeLists.txt` / `*.cmake` | repository + `GIT_TAG`, or `URL` (`cmake-dependencies.mjs`) |
| `.gitmodules` + gitlink | repository + pinned commit |
| `conanfile.txt` `[requires]`, `conanfile.py` requires strings, `conan.lock` | name + version |
| `revisor.native-deps.json` | vendored copies: `{"version":1,"vendored":[{"path","repository","revision"}]}` |
| top-level C/C++ entries under `third_party/ thirdparty/ 3rdparty/ external/ extern/ vendor/ deps/` not covered by a submodule or declaration | unidentified vendored copy |

`${VAR}` in a CMake declaration resolves only from a plain `set(VAR value)` in the same file. An
unset variable, a `GIT_REPOSITORY` without `GIT_TAG`, a submodule without a gitlink, or an undeclared
vendored copy is an *unidentified* record: reported, never guessed. A record's key is
`kind:name`; its identity is repository/URL + revision/version. A PR's **changed** dependencies are
head records whose key is new or whose identity differs from every base record with that key.
Without a merge base every record counts as changed.

## RV-NATIVE-DEPS-02: OSV lookup — what leaves the host

`src/native-deps/osv.mjs` posts to `https://api.osv.dev/v1/querybatch` (≤1000 queries per request,
30 s timeout). Only library identities are sent:

- 40-hex revision → `{"commit": sha}`
- repository + tag → `{"package":{"name":"https://host/owner/repo","ecosystem":"GIT"},"version":tag}`
  (URL canonicalized: https, lowercase host, no `.git`)
- Conan → `{"package":{"name","ecosystem":"ConanCenter"},"version"}`

No source text, file content or repository-private data is sent. A `URL` tarball without a
repository identifies nothing queryable and is not sent. A transport failure, non-2xx answer or a
result list of the wrong length is an error, never "no vulnerabilities". Observed 2026-11-07:
commit and GIT-tag queries return OSV records (zlib 1.2.11 → CVE-2018-25032 …); ConanCenter
queries returned none for the same library, so Conan coverage depends on OSV's data.

## RV-NATIVE-DEPS-03: Verdict and placement

`src/native-deps/run.mjs` produces one registered-check row, "C++ dependency vulnerabilities (OSV)":

- **failed** — a changed dependency has a known OSV vulnerability, or a changed dependency is
  unidentified (declare it so it can be checked).
- **error** — the inventory could not be read from git, or OSV could not be queried while the PR
  changed a queryable dependency (fail closed).
- **skipped** — OSV could not be queried and the PR changed no queryable dependency; the reason says so.
- **passed** — otherwise. Vulnerabilities of unchanged dependencies (`existing:`) and unidentified
  unchanged records (`unverified:`) are listed in `output` as the repository's debt, not this PR's.

No row is added when neither head nor base has C/C++ sources. `src/native-deps-ci.mjs` places the row
after the Praesidium preflight and before the registered tests (`praesidium-ci.mjs` loads it); a
failed row does not stop the tests, and `testsPassed` fails the stage on it.

## Verification

`test/native-deps.test.mjs` (no network: OSV and git are injected): CMake parsing and variables,
submodule/Conan/declaration parsing, vendored detection (C/C++ only), changed-set computation, OSV
query shapes and batching, every verdict, and row placement. A manual run on Pictor, Ergo and
Figmentum (2026-11-07) queried their FetchContent/submodule pins and listed their undeclared
vendored copies (stb, earcut, gtest, nanosvg) as unverified.

## Limits

Header-only libraries copied without a declaration cannot be identified. OSV's GIT data covers
projects that publish fixes as commit ranges; a library absent from OSV reports nothing. Version
strings in `URL` tarballs are not interpreted. Build-time `${VAR}` values from the command line or
other files are not evaluated.
