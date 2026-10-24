---
task: Praesidium security toolset and Revisor pre-test integration
project: Revisor
kind: implementation
created: 2026-10-25
memory_links: []
---

# Request

neco requested a fast security toolset to reject detectable native memory defects at build time
and unsafe Web inputs at the routing boundary, integrated into Revisor tests. Follow-up requested
investigation of the current MUSA Melpomene and replacement only if its responsibilities can be preserved.

# Acceptance evidence

- Implementation contract: `spec/feature/praesidium.md` (`RV-PRAESIDIUM-01` through `04`).
- Standalone CLI and declarative Web boundary guards; source inspection and configured Clang analysis.
- Both queued and direct/autofix registered-test routes use the mandatory Praesidium preflight.
- Named CI results include coverage and distinguish failures from incomplete analysis.
- Regression fixtures included in the existing `test/*.test.mjs` suite; local syntax checks performed.
- No locally executed unit/integration/startup tests or service restart. Revisor review is the delegated
  execution path; passing results, merge and running-service adoption must be recorded from actual outcomes.
- Melpomene's issue/notification/milestone, SceneView and runtime report responsibilities are not
  equivalent to preventive scanning. Existing features are preserved; replacement is not performed.

No Actio task identifier is fabricated. Workflow state belongs to the coordinator's current task records.
