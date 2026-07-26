# Revisor

Revisor is LUDIARS' public, independent local pull-request review service.

It accepts authenticated requests from GitHub Actions through Cloudflare
Access, queues exact PR heads, and processes them with a bounded child-process
worker pool. Reviews combine an opposite-provider coding review with Anatomia
domain, architecture, orphan-function, and complexity analysis.

The implementation is developed on the `feat/independent-service` branch.
