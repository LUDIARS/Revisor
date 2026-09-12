---
type: feature
title: Approved push handoff
service: revisor
domain: remote-publication
status: draft
---
# Approved push handoff

`revisor push --handoff <UTF-8 JSON file> --session-id <Cc session> [--json]`
extends the existing push command. Ordinary branch push keeps its current restrictions.
The operator supplies `id` (UUID), `repository` (`owner/name`), `cwd` (registered
checkout or its worktree), `reason`, and `updates` containing `ref`, `oldSha`, `newSha`.
Only heads/tags are accepted; deletion is outside this first contract. Zero old SHA
means create-only. SHA values are full 40-character Git object IDs.

## Ownership and invariants
- RV-HP-01: Rv owns credentials and publication. The submitted text is context, never authorization.
  A fresh request to the catalog-resolved Cc push-check must return the existing
  exact-operation WARNING approval. Cc owns requester identity and Discord audit.
- RV-HP-02: Persist the immutable handoff and Cc session before requesting approval.
  A duplicate ID never executes again, even after a crash. Changing content with the
  same ID is rejected. Approval expires two minutes after its response and is consumed
  before remote mutation. No approval flags are accepted in the input document.
- RV-HP-03: Share the normal publication file lock. Require registered Revisor workflow,
  verified origin, existing local objects, Cc binding, and exact expected remote SHAs.
  Push all refs atomically with explicit per-ref leases through the existing App transport.
- RV-HP-04: Persist attempting before push; failures after that boundary are unknown,
  not automatically retried. `--reconcile` only reads remote refs and records whether
  all targets match. Even unchanged refs require a new ID and fresh approval to retry.
- RV-HP-05: Do not move local checked-out branches, rewrite a working tree, change version
  state, edit Release notes, or relax normal push guards. Record remote-only publication;
  local checkout/tag synchronization remains an explicit follow-up before future publication.

## Example
```json
{
  "id": "e58bfe65-fcdd-4fa4-a9c7-465308a1f79b",
  "repository": "LUDIARS/Product",
  "cwd": "E:/Document/Ars/Product",
  "reason": "Replace the approved historical catalog",
  "updates": [{"ref":"refs/heads/main","oldSha":"1111111111111111111111111111111111111111","newSha":"2222222222222222222222222222222222222222"}]
}
```
Status/recovery uses the same file and session: `revisor push --handoff file.json
--session-id <id> --reconcile --json`. There is no automatic resubmission or restart.
The ledger is `push_handoffs` in the existing Rv database. Cc audit remains in its own
session events; no GitHub App token or approval capability is written into the handoff.

## Operator procedure
Bind the Cc session to the actual target checkout/branch before invoking the command.
Use a new UUID and exact `git ls-remote --refs` SHA values, including the annotated tag
object ID (not its peeled commit). Save the reason and updates in UTF-8 JSON. Run the
existing push command with `--handoff` and approve the new Cc Discord WARNING. An old
WARNING approval is never reused. Keep the handoff file for status and reconciliation.
No service restart is required by this CLI operation; runtime acceptance must still
follow the project's testing claim and execution authorization rules.
