# Native review scheduling budget

## RV-PRAESIDIUM-NATIVE-BUDGET

Native preflight must attempt every configured translation unit within a bounded scheduling allowance. The allowance is at least 120 seconds and otherwise one 60-second compiler timeout per two-process round, plus one round of scheduling overhead. Each analyzed file (a changed unit, or a changed header analyzed with a unit's configuration) runs two compiler processes, a diagnostics pass and the analyzer (RV-PRAESIDIUM-03), so the allowance counts processes, not files. The existing maximum of 256 analyzed files, two workers, compiler timeout, strict diagnostics, and incomplete-analysis errors remain mandatory. A file whose later pass would start after the allowance is spent is reported as `native.analysis-budget`, never as passed.

Regression evidence must cover a batch whose successful analysis extends beyond the former 120-second cutoff, and a stalled batch whose uninspected units remain errors. The change introduces no package, installation hook, or network operation.
