# Private-key fixture blocks Revisor review

- Date: 2026-08-04
- Status: fixed in working tree
- Area: leakage scan / configuration test fixture
- Severity: local PR review blocked before security scan

## Summary

Revisor local PR #200 was blocked by one `private-key` leakage finding in
`test/config.test.mjs`. The matched text was an intentionally fake PEM fixture,
not a credential, but it used the exact private-key header that the leakage gate
must reject in added source.

## Evidence

The review for head `b1f3782` reported:

```text
rule: private-key
path: test/config.test.mjs
line: 116
```

Security scanning was skipped because the leakage gate had not passed.

## Regression Context

The GitHub App credential feature added its encryption round-trip test in the
same change that introduced the stricter publication boundary. The test fixture
was functionally fake but textually indistinguishable from a committed private
key header to a deliberately content-based pre-publication scanner.

## Cause

The test stored the complete PEM begin/end markers as one source literal. The
`private-key` rule correctly treats that marker as a potential secret and does
not maintain a test-file exception, because such an exception would also permit
real test credentials to leave the workstation.

## Fix Requirements

- Keep exercising the same encrypted credential read/write/remove path.
- Do not weaken or bypass the `private-key` leakage rule.
- Keep the complete PEM marker out of the added source diff.

## Verification

The fixture now constructs its fake PEM marker at runtime from separate source
fragments. Static diff inspection confirms the complete marker is absent from
the changed line. Unit, integration, and startup tests were not run per session
policy; Revisor will rescan the updated local PR.

## Follow-up

When a test must exercise a secret-shaped parser, construct the sentinel from
non-secret fragments instead of adding a complete credential signature to the
repository.
