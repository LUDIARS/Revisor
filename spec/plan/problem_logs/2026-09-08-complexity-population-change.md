# Aggregate complexity blocks feature introduction

Status: implemented in task worktree; 65 focused unit tests pass.
Anatomia snapshot typecheck/build and 3 unit tests also pass.
Not deployed: Anatomia snapshot support must land before Revisor uses it;
older installed analysis retains the legacy gate until both updates are active.
Tela #1512 was blocked twice at -17 and -16 despite native-host SRP improvements.
The baseline population was the minimal declaration core. Adding callable
framework functions changes average call fan-out; it does not establish that
an existing function regressed. The reported cyclomatic metric is actually
call-out-degree-plus-one. The orphan advisory means no static caller, not missing
specification links; public callbacks may appear there.

## Comparable function complexity

Versioned Anatomia snapshots match path/type/name/signature identities and then
unique unchanged structural bodies across moves. New/deleted functions are counted
separately. The worst negative score delta among matched functions is gated by
the existing threshold, so additions or unrelated improvements cannot dilute it.
New functions remain subject to all existing architecture/security/reviewer gates;
their maximum metric is reported separately, without inventing a historical score.
Duplicate shared identities or missing/invalid snapshots use the legacy aggregate
policy with an explicit reason. No threshold or unrelated gate is disabled.
Partial retries persist/reuse baseline snapshots. Old reports retain legacy checks.
Tests must cover addition-only, a regression hidden by many trivial additions,
removals/moves, ambiguous identity, invalid metrics and legacy compatibility.

Unchanged structural bodies whose graph metric changes are reported as graph-context
changes, not authored complexity regressions: new symbol resolution can add a call
edge without changing that function's source. Edited existing bodies still gate.
Tela reproduction: 6 baseline / 132 head functions; 2 unchanged-body matches,
130 new or unmatched identities and 4 removed or unmatched identities. Both matches
changed graph metric 1 to 2 without body edits. Snapshot-based delta is zero, with
2 graph-context changes reported. These counts do not prove all moved/edited or
signature-changed functions are new; unmatched identities remain review evidence.
