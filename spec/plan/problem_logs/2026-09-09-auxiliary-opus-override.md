# Auxiliary work inherited the Opus review override

- Date: 2026-09-09
- Area: review model selection

## Evidence and cause

An active Opus override applied to test repair and PR narrative generation as well
as review judgment, defeating the purpose-based auxiliary tier. Model and effort
overrides were resolved without distinguishing review judgment from auxiliary work.

## Fix requirements

Auxiliary work must ignore review model/effort overrides, choose the less busy
provider within the Revisor review pool, and try the other auxiliary provider once
on a capacity failure. Review judgment must retain its existing override policy.
Pool accounting represents Revisor work only, not machine-wide subscription usage.

## Verification

Revisor should cover forced Opus/Sol with auxiliary purpose, unequal/equal pool
load, release after completion/worker failure, one capacity retry, no retry on
ordinary failure, and unchanged strong review selection. Local tests are not run
under the session policy; syntax and diff checks precede local PR submission.
