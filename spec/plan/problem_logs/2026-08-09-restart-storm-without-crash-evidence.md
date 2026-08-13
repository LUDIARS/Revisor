---
title: Revisor restarts roughly 22 times a day and leaves no crash evidence
date: 2026-08-09
status: investigating
service: revisor
---

# Revisor restarts roughly 22 times a day and leaves no crash evidence

## Symptom

Excubitor reports `state: stopped`, `health_reason: failed` for `revisor`, with
22 incidents and a 0.67 uptime ratio over 24 hours. Local PR submission fails at
Concordia with `submitted: false / fetch failed` because nothing is listening on
the managed loopback port. Merges do not progress while the service is down, so
Test OK PRs pile up.

## Evidence gathered (2026-08-09)

- The supervisor-captured stderr contains **no exception and no stack across
  every restart** — only the repeated Node SQLite experimental warning. Its
  stdout shows only the loopback listener banner
  after each one. The process therefore does not die from an uncaught error in
  a way anyone can see; it is ended from outside, or it dies without writing.
- One `EADDRINUSE` listener failure shows a restart began while the previous
  process still held the managed port.
- The configured `${VESTIGIUM_LOGS_DIR}/revisor/` directory is **empty since
  2026-07-27**. Only six services write Vestigium JSONL; Revisor is not one of
  them, so `excubitor_query_logs` returns nothing for it.
- Manual-launch log and PID artifacts in the supervisor state directory show
  the service also being started **outside Excubitor supervision** on the same
  day. Two supervisors over one port is consistent with the EADDRINUSE.
- Open error task `[memory-leak] revisor RSS +441.2MB/h (0→815MiB) over 35min,
  60% monotonic`, 237 occurrences, alongside `[cpu-high] host CPU 93.1%`.
- Each restart requeues its interrupted reviews (`scanned=13 requeued=13`), so a
  restart adds load, which makes the next probe more likely to fail.

## Hypotheses, none yet confirmed

1. The health probe (`/health`, 30s) times out because the event loop is blocked
   by synchronous work, and the supervisor restarts a process that is alive.
   This is the same shape as Concordia's stall (synchronous full scans).
2. Manual launches and Excubitor fight over the managed loopback port.
3. Genuine memory growth ends the process.

## Next step

Nothing above can be settled from the current logs, so the first change is to
make the ending observable rather than to guess: `runtime-diagnostics` records
`signal_received` (stopped by a supervisor) separately from
`uncaught_exception` (died on its own), plus RSS and event loop lag every 30
seconds. Hypothesis 1 predicts rising `eventLoopLagMs` before a
`signal_received`; hypothesis 3 predicts monotonic `rssMb` with no signal.

Once one incident is captured with this instrumentation, this log gets its cause
and resolution sections and the instrumentation is trimmed to what stays useful.

## Verification expectation

Registered unit tests must cover record redaction and write-failure isolation,
heartbeat delay measurement and interval validation, signal re-delivery and
listener cleanup, merge stage events, and worker lifecycle events. An operational
check must then confirm that Excubitor startup, one heartbeat, and a controlled
SIGTERM appear in the configured Vestigium JSONL file.
