# Native compiler failure evidence was discarded

Odeum local PR 3827 reported a failed `native/lesson/connection.cpp` check without
actionable locations. The process adapter retained only exit status and a boolean
warning detector; the batch discarded all diagnostic text.

Reproduction on 2026-11-16 completed in 73025 ms with exit 0, and two
`deadcode.DeadStores` warnings in the installed Boost 1.87 `inflate_stream.ipp`
(319:21 and 1072:21). This diagnostic reproduction used a 180-second observation
limit; production still uses 60 seconds. It does not prove the original review timed
out: the original report said failed rather than incomplete.

Fix: use the existing redacted, bounded failure-output boundary and propagate it to
the native check. A killed process is described as terminated, not conclusively a
timeout. No gate, checker, dependency or compiler argument changes.

Validation: 19 targeted tests passed. Source warning rejection and missing-compiler
failure remain covered. No dependencies added; lockfile declares only the existing
MIT local one-shot package, no install lifecycle scripts or transitive packages.
The worktree has no populated one-shot submodule; it was not installed or changed.

After the first submission, merge-side main `b2c86e9` was discovered to contain a
multi-pass native analysis redesign absent from the source checkout. Integration
preserves its crash handling, dependency validation, expansion suppression checks,
host-header treatment and pass ordering. Expanded source stdout is never retained.
After integration, 4 evidence tests and 7 targeted batch/gate tests passed. The
broader scan suite is not green on this Windows environment: inherited cases hit
Git fixture failures and a slash/backslash assertion; real-Clang cases skip because
clang is not on PATH (the registered host compiler is available by absolute path).

## Registered-suite follow-up

The failed review identified three portable-test defects: native absolute path
spellings were compared as raw strings, repository-relative fixture observations
retained Windows backslashes, and a 1.5-second deep-tree assertion depended on host
load. Compare canonical path identities and slash-separated repository IDs. Count
filesystem work rather than elapsed time, retaining the 300-file deep-tree and
symlink boundary checks. Enable long paths only in that private Git fixture.
All three previously failing cases pass after these changes; four diagnostic
evidence tests also pass.

The hardened analyzer completed the real Odeum connection unit without warnings in
80755 ms when observed with a diagnostic 180-second bound. Its production 60-second
bound terminated it. Increase the fixed process cap to 120 seconds; preserve two
workers, output limits, checker selection and failure semantics. The batch budget
continues to derive from the process cap. No packages, install hooks, network access
or native-memory handling were added; compiler execution remains shell-free.

The next registered run exposed two remaining fixture problems: the simulated
probe budget still assumed 60-second processes, and `nul.txt` is a Windows reserved
device name. Derive the simulated clock from `nativeSchedulingBudget`, and name the
unchanged NUL-bearing fixture `contains-nul.txt`. Capturing the Git fixture's stderr
made the previously hidden `unable to index file` error actionable. Both regression
cases pass; the unsafe source bytes still fail the production scanner as required.

Combined local regression run (`native-process-result`, `praesidium-scan`,
`praesidium-files`, `praesidium-input`): 54 passed, 0 failed, 19 skipped in 92 seconds.
The skipped real-compiler/POSIX cases remain unverified by this run; the separately
recorded real Odeum compiler invocation uses the host's absolute compiler path.
