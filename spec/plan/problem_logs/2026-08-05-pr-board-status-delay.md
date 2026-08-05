# PR board status changes were delayed

- Date: 2026-08-05
- Status: fixed in working tree
- Area: Revisor PR board
- Severity: operator-visible stale state

## Summary

The PR board learned about review, test, and merge transitions only through a
three-second polling loop. Operators could therefore continue seeing an old PR
state after Revisor had already persisted the next state, and the page provided
no event trail explaining when a transition arrived.

## Cause

`LocalPrStore` persisted transitions to the JSON state file, but exposed no
process-local change signal. The browser had no realtime channel and repeatedly
downloaded the full PR list instead.

## Fix Requirements

- Publish an identifier-only event after every successful PR creation or update.
- Deliver events to authenticated, same-origin UI clients over WebSocket.
- Refetch the authoritative PR and test-workflow projections after an event.
- Show connection and PR status events at the bottom of the right PR pane.
- Reconnect with bounded backoff without restoring the three-second poll.
- Close sockets and listeners during Revisor shutdown.

## Verification

Focused tests cover the RFC 6455 handshake/frame, Origin and session checks,
event fan-out, state-store emission, and generated page wiring. Revisor's
registered `unit` and `check` cases will run through the local PR workflow.
