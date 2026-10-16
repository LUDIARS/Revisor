---
title: LUDIARS 9-tool design review — Revisor
type: plan
status: proposed
updated: 2026-10-17
---

# Revisor: bounded projections without weakening the review and merge owner

Rv owns submitted-head review, verification gates, merge and publication state.
Cc coordinates requesters and authorization; Actio tracks work; Pf owns requirements;
An owns source analysis; Augur plans/runs tests; Br derives summaries; Genius advises;
Cf owns game adoption. A passing code gate does not imply human experience acceptance.

Reviewed main f11f5fa: package.json, README.md, src/server.mjs,
src/local-pr-service.mjs (listRepositories / storedPullRequests),
src/state-store.mjs (repository and PR persistence), excubitor.catalog.yaml.

Implemented README runtime minimum correction: package engines requires 22.12.0,
while the setup text still said 22.5. No runtime, engine range or dependency changed.

## Findings, counterarguments and priorities

1. The handoff's repeated expensive repository-list projection is partly superseded:
   current listRepositories uses storedPullRequests with store.listVersion-backed
   cache. Do not report the historic response cost as today's measurement or add
   a second cache without profiling. Acceptance for further work: equivalent list
   results, bounded memory, invalidation after mutations, measured cold/warm cost.
2. Br still opens several CLI processes for one summary. Prefer an owner-produced,
   bounded projection over parallel callers opening the review database. Acceptance:
   repository registration, selected merged PR risks/An gates and version retain
   provenance; no full audit bodies or credentials are included.
3. Keep Augur planning subordinate to the mandatory review safety floor. Docs-only,
   missing ledger, skipped tests and executed tests must remain distinguishable.
   An's inferred domain membership is evidence, not authority to move ownership.
4. Cc bind and merge requests need typed, bounded error semantics. A lost response
   is not proof of failure; reconcile the existing request/PR before retrying.
   Preserve reviewed-head equality, authorization and merge gates while improving
   diagnostics. Never use stale Test OK for a different head.
5. Expose source revision and deployment/reflection separately for Br/Cf/Pf.
   Merged, published, running and human-verified are different facts. Avoid polling
   the review queue as a substitute for its terminal session notifications.

Cross-service batch projection and deeper storage changes remain proposals.
No speedup, total gate enforcement or human UX approval is claimed.

Validation: source consistency and git diff --check. Tests and services were not
run in this session. Recovery: revert documentation; no state migration, release
or restart is necessary. Existing main checkout changes remain untouched.
