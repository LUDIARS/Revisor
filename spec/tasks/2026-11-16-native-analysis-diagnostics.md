---
task: native-analysis-diagnostics
project: Rv
kind: fix
created: 2026-11-16
memory_links: []
---

# Native analysis failure evidence

User instruction: investigate and fix Odeum lesson review failures, including the
review infrastructure where necessary. Related Actio task:
`14b11162-32a3-415f-8091-232b22977ea7`.

Preserve bounded, redacted compiler diagnostics in failed native checks. Distinguish
diagnostic-only failure, process termination, output overflow, missing compiler and
other compiler errors. Do not relax warning/error checks or change analysis limits.

Acceptance: warnings still fail; clean analysis has no stored output; failures retain
locations through the batch report; existing secret redaction and byte limits apply.
This repairs observability, not Boost diagnostics or Odeum runtime verification.
