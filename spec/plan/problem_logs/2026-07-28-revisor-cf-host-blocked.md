# Revisor Cloudflare Host Blocked

- Date: 2026-07-28
- Status: fixed in working tree
- Area: Revisor UI host validation
- Severity: external administration unavailable

## Summary

Revisor returned `{"error":"Loopback host required."}` when its loopback UI was
published through a configured Cloudflare Tunnel. This prevented the operator
from using the Revisor status and settings UI through the intended hostname.

## Evidence

- User-visible response on 2026-07-28:
  `{"error":"Loopback host required."}`
- `src/ui-server.mjs` rejected every `Host` header that was not loopback.
- `src/ui-security.mjs` had no configured-host policy.

## Regression Context

The first local PR workflow release intentionally restricted the UI to loopback,
but omitted the external-host configuration already used by other LUDIARS web
services. The Cloudflare access path was therefore not covered by its tests.

## Cause

Host authorization was a fixed code predicate. Revisor's encrypted local config
stored the workflow token but had no encrypted allowed-host list.

## Fix Requirements

- Keep loopback hostnames permanently allowed.
- Let operators register exact external hostnames from the loopback settings UI.
- Store configured hostname values with Revisor's existing encrypted-config
  mechanism.
- Reject malformed and unregistered host headers.
- Apply saved host changes without exposing secrets or requiring a restart.

## Verification

- Add config tests proving hostnames are absent from plaintext config.
- Add policy tests for loopback, configured hosts, and unregistered hosts.
- Add a server regression test that reaches `/health` through a configured host.
- Run the complete Revisor test and syntax-check suites.

## Follow-up

After local-main integration, restart Revisor through Excubitor because the
running Node process must load the new server code. Configure the Cloudflare
hostname from loopback and verify the external response.
