---
type: feature
title: "review-fast-lane — explicit reserved review capacity"
description: "Assign durable standard/fast lanes to local review jobs and reserve bounded worker capacity without allowing either lane to borrow from the other."
service: revisor
domain: review-queue-scheduling
tags:
  - review-queue
  - scheduling
  - local-pr
status: implemented
related:
  - ./daemonless-cli.md
  - ./pr-lifecycle.md
updated: 2026-08-11
---

# Review fast lane

## SPEC-REVIEW-FAST-LANE-DURABILITY: Contract

Every review job has one durable lane: `standard` or `fast`. Missing legacy data
migrates to `standard`. Submission and manual retry use `standard` unless the
caller explicitly sends `fast_lane: true`. A queued standard job can be promoted;
promotion is idempotent, joins the tail of the fast FIFO, and cannot demote,
preempt, or move running/settled work.

## SPEC-REVIEW-FAST-LANE-CAPACITY: Capacity

`fastLaneSlots` reserves one or two workers from each configured review-stage
pool and from outer PR orchestration. At least one standard worker remains.
Standard work never borrows the reservation, and fast work does not borrow the
standard partition. With `workerCount: 1`, `fastLaneSlots` is `0` and an explicit
fast request fails instead of silently stealing the only standard slot.
Persisted fast jobs are held when the reservation is zero; they never drain
through standard capacity after an operator reduces the configuration.

The durable outer scheduler runs multiple PRs and checks for newly queued work
while standard reviews are active. This is necessary because the process
presence lock prevents a new submitter from starting a second drain worker.

## SPEC-REVIEW-FAST-LANE-AUTHORITY: Interfaces and authority

- Submit or retry: JSON `fast_lane: true`, CLI `--fast-lane`, or the dashboard
  checkbox. Omission and `false` mean standard.
- Promote: `POST /v1/local-prs/:id/fast-lane`,
  `revisor pr fast-lane <number>`, or the queued-PR board action.
- The workflow API remains token-protected. A supplied Concordia `session_id`
  must match the PR submitter. Concordia additionally checks that the owning
  session is active and records an audit event.

Lane is canonical in `revisor.jobs.json`, survives restart/reclaim, and appears
in queue/API/UI state. Manual retry needs a fresh opt-in; automatic recovery
retains the interrupted job lane.
Fast FIFO order uses a durable monotonic entry sequence instead of wall-clock
timestamps, so submissions and promotions in the same clock tick stay ordered.
