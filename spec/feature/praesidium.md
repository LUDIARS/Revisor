---
type: feature
title: Praesidium — deterministic security toolset
description: Pre-test source policy, native static analysis and reusable web ingress contracts.
service: revisor
domain: review-gate
status: implemented
---

# Praesidium

## RV-PRAESIDIUM-01: Offline source policy and explicit coverage

Praesidium (Latin: protection) is an independently callable CLI shipped with Revisor.
`node src/praesidium/cli.mjs --repo <repository> [--base <ref>]` or installed `praesidium --repo <repository>`
emits one JSON object; exit 0 is the configured checks passing, 1 is findings/failing checks,
2 is an incomplete inspection. It uses no LLM, remote API, new npm dependency or application launch.

The baseline scans Git-tracked and nonignored new C/C++ and JS/TS source files, including tests.
Only regular files inside the canonical repository boundary are read; malformed UTF-8, missing
files, symlinks escaping the root and size limits fail closed. Limits: 30,000 listed files,
2 MiB per source, 32 MiB aggregate, 4 MiB Git listing. Submodule content is not traversed.
Rule findings retain only rule/file/line/severity, never source snippets or request values.
Findings are bounded at 200 per source plus a limit marker, and 1000 per report; hitting a cap
remains a failure and coverage reports the incomplete/truncated policy inspection explicitly.

Current policy rejects unbounded C copy/format APIs (`gets`, `strcpy`, `strcat`, `sprintf`,
`vsprintf`, wide-character variants), direct JS dynamic code evaluation, and simple direct
request-to-HTML/shell assignments. These are **syntactic tripwires**, not AST/taint analysis.
Comments and literals are masked; interpolation, aliases, macros, indirect calls, code generation,
complex control flow and unsupported languages can evade them. No findings is not a safety proof.
Whole-template masking deliberately avoids false positives in generated source text; actual
template-expression execution remains a coverage gap, covered by other reviews, not by this scanner.

### JS evaluator identity versus service methods

`web.dynamic-code` identifies bare `eval` / `Function` calls and calls qualified by
`globalThis`, `window`, `self` or `global`, including optional-call syntax. A method
on another receiver (such as Redis `eval`, which executes Lua on Redis rather than
JavaScript in the process) is not a direct JS evaluator. Typed TS parameter
declarations are not runtime calls. These distinctions apply uniformly, with no
repository/path allowlist or configurable finding suppression. Aliases and arbitrary
object properties that refer to a built-in remain outside this syntactic rule;
this is not a semantic proof of their safety. Other review stages still apply.

Regression coverage preserves direct/global calls, object and ternary arguments,
comment-separated globals, line attribution, Redis calls and typed test doubles.
This correction addresses Actio `23bc8364-69fb-40bc-9c0a-401700bde8ea` / Cernere PR3494.

## RV-PRAESIDIUM-02: Compile web field contracts once; reject at runtime ingress

`src/praesidium/input-guard.mjs` exports `compileRouteGuard(contract)`. Compile at service startup,
then call the returned guard with the **raw, unnormalized** request target before routing and
before doing application work. Use the returned sanitized `params/query/body`, not the raw input.
This is Node-compatible, framework-neutral code, with no application code imports during inspection.

Accepted fields are explicitly enumerated. Supported fields are bounded strings (optional slug,
UUID or enum), safe integers with min/max, and booleans. Unknown fields, non-scalar bodies,
duplicate JSON keys, duplicate/encoded duplicate query parameters and malformed JSON are rejected.
Paths reject dot segments, encoded slash/backslash, residual percent escapes (double decode risk),
controls and malformed escapes. Methods and literal path segments must match. JSON requests require
the declared content type. Target length is capped at 4096; body bytes are checked before JSON.parse.
Contracts allow at most 64 fields, 256 enum values and a 1 MiB body ceiling.
No user-supplied regex is compiled, avoiding a new regular-expression denial-of-service surface.

The caller **must also cap body bytes while receiving the stream**, before accumulating `bodyText`.
This library does not own sockets, proxy normalization, authentication, authorization, CSRF,
SQL parameter binding, contextual HTML escaping or rate limiting. A valid string remains data,
not safe HTML/SQL/shell syntax. Quotes and Unicode in free text remain valid where the schema permits.
Dynamic requests cannot be validated at build time; the build validates the policy and regression
examples, while the precompiled bounded guard enforces it at ingress.

Declare shared production contracts and positive/negative examples in `praesidium.json`:

```json
{
  "version": 1,
  "native": [],
  "web": [{
    "name": "get-item",
    "contract": {
      "method": "GET", "path": "/items/:id", "maxBodyBytes": 0,
      "params": {"id": {"type": "string", "format": "slug", "maxLength": 32, "required": true}},
      "query": {"page": {"type": "integer", "min": 1, "max": 100}},
      "body": {}
    },
    "cases": [
      {"request": {"method": "GET", "target": "/items/abc?page=1"}, "accept": true},
      {"request": {"method": "GET", "target": "/items/%2e%2e"}, "accept": false}
    ]
  }]
}
```

Service usage (load the same checked-in config through the service's configuration loader):

```js
const guard = compileRouteGuard(config.web[0].contract); // once, at startup
const checked = guard({ method: req.method, target: req.url, bodyText, contentType });
if (!checked.ok) { res.writeHead(checked.status); res.end(); return; }
// Only now use checked.params / checked.query / checked.body in the handler.
```

The runner also supplies mandatory traversal, double-encoding, malformed-escape, prototype-key and
oversize probes. An invalid contract or missing acceptance/rejection examples is an error.
The result always says `webRuntimeWiring: not-verified`: passing a contract suite cannot prove
that a service actually calls the guard. That requires the service's registered integration tests.
Without web contracts the report explicitly has `webContracts: 0`; no claim of protected routes is made.

## RV-PRAESIDIUM-03: Native compile-time analysis

Native configuration is required for the C/C++ files the reviewed change touches, not for every
native file in the repository. The review test stage passes the PR's changed set: paths added or
modified in the worktree relative to its merge base with the base branch, plus nonignored new files;
deleted paths are excluded (`changedSourcePaths` in `files.mjs`, wired through `mergeBase` in the
`runner.mjs` test-stage options and `praesidium-ci.mjs`). With that set:

- every changed translation unit must have a `native` entry, otherwise `native.configuration-required`;
- a changed header requires at least one configured unit (scoped fail-closed check). A header-only
  change compiles no unit, because header-to-unit inclusion is not derived; it is a coverage gap,
  not a pass claim on including units;
- only configured units whose file is in the changed set are compiled. Entries for unchanged files are
  still validated for shape (keys, standard, include/define grammar, duplicates, tracked file) but are
  neither compiled nor resolved against host packages;
- the 256 limit applies to the number of analyzed units, not to the length of `native`.

Policy rules (RV-PRAESIDIUM-01) still scan every collected source; only native analysis is scoped.
Fail closed: without a merge base, or when Git cannot compute the changed set, the scan falls back to
the whole-repository requirement (every tracked unit configured and compiled). The report's
`coverage.nativeScope` is `changed` or `repository` accordingly. The CLI keeps the whole-repository
scope unless `--base <ref>` is given: `praesidium --repo <repository> --base origin/main`.
The host needs `clang` / `clang++` on its trusted PATH or explicitly configured absolute compiler
paths in its host configuration. Praesidium never installs them automatically.

```json
{"version":1,"native":[{"file":"src/parser.cpp","standard":"c++20","includes":["include"],"defines":["FEATURE=1"]}],"web":[]}
```

The adapter invokes Clang's analyzer with `core,unix,security`, text diagnostics, `-Wall -Wextra
-Werror`, a fixed language standard and validated include/define arguments. It never links or runs
a binary, runs build/install scripts, loads analyzer plugins or accepts arbitrary compiler options.
Repository-supplied include paths remain restricted to directories within the repository;
definitions have a narrow grammar. Host-installed libraries can be requested by package name
using `"packages":["tela"]` on a native unit. Only the administrator-owned `praesidium.host.json`
next to the resolved Revisor config can map these names to absolute include directories:

```json
{"version":1,"compilers":{"cpp":"C:/Program Files/LLVM/bin/clang++.exe"},"includePackages":{"tela":"C:/installed/tela/include"}}
```

The host config must be outside the reviewed repository, has a 64 KiB limit and at most 64
packages, and all configured locations must exist. Unknown packages fail closed. PR configuration
cannot supply host paths, executable names, install commands or compiler flags. Host libraries
are trusted toolchain inputs like SDK headers; their source and updates are an operator concern,
not a claim of inspected third-party code. No repository setup runs before security preflight.
This supports a cold checkout without running installers or copying unchecked code into it.

Per-process timeout is 60 seconds / output cap 2 MiB; at most two compiler workers run concurrently.
The shared batch stops scheduling units after 120 seconds, reports every unstarted unit as an error,
and awaits all in-flight compilers. Configuration is validated in full before workers start.
Actio `bb56075c-dbb1-4f6e-8aec-47e5f3fd7d28` scoped native analysis to the changed set after
Figmentum (464 native sources) and Pictor (288) could never pass the whole-repository requirement.
Missing compiler, invalid/missing configuration, timeout, output overflow
or diagnostic errors do not pass. Warnings fail even when Clang returns exit 0. Diagnostics are
not retained, because they can contain secrets from source/header content.

Build variants/defines/include paths must match the product's build. Header inclusion coverage,
link-time behavior, third-party/submodule sources, concurrency and all memory errors are not proven.
Unsupported build contexts fail until configured or remain outside declared coverage, never a claim
that C++ has become memory safe. Rust's safe-code guarantees, runtime bounds checks, OS isolation,
compiler hardening and sanitizers remain complementary. Some attacks can be prevented at runtime;
the premise that runtime protection is inherently impossible is not adopted.

## RV-PRAESIDIUM-04: Revisor test gate

`praesidium-ci.mjs` wraps the existing `runPlannedTests` at both production call sites:
`review-work.mjs` (queued test stage) and `runner.mjs` (direct/autofix/verification paths).
It emits a named `Praesidium security preflight` CI result **before** setup/install, registered cases
or Augur domain bundles. Failed/error/unrecognized/thrown results prevent those later operations.
The existing `testsPassed` gate blocks the returned failure. A test selector cannot remove this
preflight when the test stage runs. A wholly skipped registered-tests stage does not run it;
the existing mandatory registered-test selection for executable/dependency changes remains intact.
Existing LLM security scan, leakage checks and merge gates are preserved. The built-in preflight
result is added when the updated Revisor runner is deployed. The optional HTTP server only enqueues
jobs: `worker-spawn.mjs` starts `cli.mjs run-worker`, which imports `runner.mjs` and owns the stage
workers. A newly spawned worker reads the merged modules; no server restart is required for this change.

Tests: `test/praesidium-{input,scan,files,ci}.test.mjs`. The repository's npm test script discovers
them, but the live Revisor registry previously selected only `one-shot-runtime-tests`
(`test/process.test.mjs`, `test/codex-runtime.test.mjs`), not the whole npm suite. Therefore #3444's
Test OK is evidence for those existing registered checks, **not** a passing Praesidium regression suite.

The existing `LUDIARS/Revisor` registration was updated through the authenticated registration API
and read back, preserving all four prior cases and notification/workflow settings. Added case:

```json
{
  "name": "praesidium-regression-tests",
  "command": "node",
  "args": ["--test", "test/praesidium-input.test.mjs", "test/praesidium-scan.test.mjs", "test/praesidium-files.test.mjs", "test/praesidium-ci.test.mjs", "test/ui.test.mjs", "test/ui-dashboard-refresh.test.mjs", "test/refactoring-proposal-cache.test.mjs"],
  "cwd": ".", "timeout_ms": 120000, "always": true, "runtime": false
}
```

These tests require only Node and Git, not installed npm packages or initialized submodules.
The CI adapter lazily imports the existing dependency-bearing runner only when actually running
registered tests after a passing scan; its injected regression tests never load that runner.
This permits the always-on case to run even for docs-only changes whose dependency setup is skipped.
The registry lives in Revisor's state, not in package.json; recreating a registration must preserve
this named case. Read-back proves registration, not execution. Later review CI results are the
execution evidence; syntax verification alone is not a test pass.

Review #3445 initially stopped in the deployed preflight before registered tests ran.
Read-only collection reproduced `non-text source`: `src/refactoring-proposal-cache.mjs`
contained one literal NUL byte inside the cache-key template literal. Representing that
separator as the JavaScript `\0` escape preserves the runtime key while making the source
text inspectable. The collector still rejects raw NUL bytes; a regression fixture checks
both escaped and raw representations. Passing delegated review remains required.

## Melpomene replacement decision

Ars-Musa inspected at `5b4ebe28ab7afe46968bf4f140f5fc965b5edb73`:
`melpomene/src-tauri/src/lib.rs` registers issue CRUD/comments, scene/position ticket lookup,
notification/PR/review/workflow queries, milestones and configuration. Its TypeScript API exposes
these operations. The optional Rust web server currently exposes only `/api/health`, not a security scanner.
`docs/DESIGN.md` §4-D describes QA/bug tracking; planned Actio/Nuntius links are not treated as verified.
Praeforma has an ars-musa project but no matching retrieved security spec; Anatomia has no ars-musa
registry entry. Inspection therefore used the local implementation and specs without registering a project.

UnityFoundation `spec/tools/Musa.md` and `spec/code/Debug/Melpomene{,Runtime}.md` additionally document
the Musa editor tab, SceneView ticket UI and a separate in-game bug-report form (GitHub/direct relay).
These are different responsibilities and are not supplied by this tool. Replacing Melpomene wholesale
would remove user-facing features; no replacement/deletion/rename is performed. Praesidium remains
a separate preventive tool. Current usage or redundancy has not been proven, so retirement is not inferred.

## Evidence / limits

Revisor baseline `b743f60`: existing `security-scan.md`, `review-gate.md`, `ci.mjs`,
`review-work.mjs`, `runner.mjs`. Anatomia context returned these review-gate/CI entry points;
its ontology/cache warnings mean persistence was not verified. Praeforma project
`01M3FVMG4SGXX9V4XN4VAKJ2DP` was read; no matching security feature was returned in that listing.
The new specification here is the implementation contract, not a retroactive assertion of approval.

Primary references:
- https://clang.llvm.org/docs/ClangStaticAnalyzer.html
- https://clang.llvm.org/docs/analyzer/checkers.html
- https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

## UI test integration correction

The next review of #3445 reached all 349 files and rejected 12 dynamic-code calls
in existing UI tests. Following explicit human approval, UI views, actions, filters,
client requests and dashboard lifecycle are ordinary exported functions. Browser
source is serialized from these same functions; behavioral tests import them directly.
Syntax-only checks use node:vm Script compilation without invoking a run method.
No source-policy exclusions or weaker detection rules are introduced.
The registered Praesidium case also includes UI, dashboard-refresh and cache regression
files so these changes receive delegated execution. Local checks are syntax-only.
