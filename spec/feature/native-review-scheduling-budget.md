# Native review scheduling budget

## RV-PRAESIDIUM-NATIVE-BUDGET

Native preflight must attempt every configured translation unit within a bounded scheduling allowance. The allowance is at least 120 seconds and otherwise one 60-second compiler timeout per two-unit round, plus one round of scheduling overhead. The existing maximum of 256 units, two workers, compiler timeout, strict diagnostics, and incomplete-analysis errors remain mandatory.

Regression evidence must cover a batch whose successful analysis extends beyond the former 120-second cutoff, and a stalled batch whose uninspected units remain errors. The change introduces no package, installation hook, or network operation.
