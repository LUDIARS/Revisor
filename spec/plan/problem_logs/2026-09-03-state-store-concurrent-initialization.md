# Concurrent state database initialization is flaky

- Date: 2026-09-03
- Status: fixed in working tree
- Area: Revisor SQLite state store
- Severity: high — concurrent CLI startup can make valid state temporarily unreadable

## Summary

This is a recurring concurrency regression: starting eight state-store writers together could fail with
`Revisor state is unreadable` instead of preserving every pull request.

## Evidence

- Eight processes started against a missing state path reproduced 9 failures in 64 starts.
- The nested error was `Unexpected end of JSON input` or `SQLITE_BUSY` / `database is locked`.
- The failure paths were `displaceLegacyJson()` and WAL setup in `openRevisorDatabase()`.

## Regression Context

The state store already uses SQLite WAL and a 60-second busy timeout for cross-process access. Initial
database creation still had a short empty-file window and WAL mode changes can bypass that busy handler.

## Cause

One process could observe the empty file created by another before SQLite wrote its header and parse it as
legacy JSON. A second time-of-check/time-of-use window existed between the header probe and the full read.
Concurrent first connections could also receive an immediate busy error while switching journal mode.

## Fix Requirements

- Treat only a zero-byte state file as an in-progress fresh database, without archiving it.
- Recheck the full read for a SQLite header before parsing legacy JSON.
- Retry only SQLite busy failures during the bounded WAL transition and close failed connections.
- Continue rejecting and preserving non-empty malformed legacy state.

## Verification

- `test/state-store-concurrency.test.mjs` must preserve all records and unique numbers across eight writers.
- `test/state-store.test.mjs` must cover zero-byte, malformed, and whitespace-only state files.
- Tests were not run in this review because Revisor owns test execution.

## Follow-up

No manual or visual product exercise is required; the registered process-concurrency tests cover the affected
persistence boundary.
