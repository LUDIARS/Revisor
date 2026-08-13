# Active Revisor DB permission repair blocks CLI

- Date: 2026-08-13
- Status: fixed in working tree
- Area: Revisor SQLite state store
- Severity: high — operational CLI commands cannot run while Revisor is serving requests

## Summary

This is a regression: a Revisor CLI process could not read or operate on the active local PR state while the Revisor server was running. The CLI surfaced the failure as `Revisor state is unreadable`.

## Evidence

- The running Revisor HTTP API returned local PR data.
- A concurrent CLI state read failed with:

  ```text
  Revisor state is unreadable: <configured Revisor database>
  EPERM: operation not permitted, chmod '<configured Revisor database>'
  ```

- The failure originated in `openRevisorDatabase()` via `secureDatabaseFiles()`.

## Regression Context

SQLite WAL was adopted so that readers and writers could coexist. Reapplying file permissions every time a process opens an already-active database bypassed that concurrency design on Windows.

## Cause

`openRevisorDatabase()` called `secureDatabaseFiles()` unconditionally. Windows rejects the permission change while the server has the DB, WAL, or SHM file open, so a second CLI process failed before it could use SQLite's busy timeout and WAL mode.

## Fix Requirements

- Apply the permission setup only when creating a new database.
- Never run `chmod` for an existing active Revisor database.
- Preserve WAL and busy-timeout setup for every connection.

## Verification

- Required regression coverage: open the same existing database from a second process while the server holds it, and confirm a read succeeds without attempting `chmod`.
- Tests were not run because the user did not request them.

## Follow-up

- Confirm the Revisor CLI can inspect and perform its documented local PR operations while the server is running.
