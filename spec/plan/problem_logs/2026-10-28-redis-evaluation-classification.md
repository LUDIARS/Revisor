# Redis methods classified as JavaScript evaluation

Cernere PR3494 stopped in Praesidium on eight unchanged lines: Redis Lua calls,
a typed interface method and a typed test double. The lexical rule matched any
`eval(` token, ignoring receiver and declaration context. No unsafe application
behavior was established by this finding. This patch distinguishes direct JS
evaluation from service methods and TS signatures; it does not disable the scan,
add repository exceptions, change Cernere authentication, or execute Redis scripts.

The user requested completion through deployment on 2026-10-28 after this blocker
was reported. Keep this prerequisite in a separate reviewed PR. Acceptance:
direct/global JS evaluation remains blocked; the reported Redis examples no longer
raise the JS-only rule; other source-policy rules and fail-closed behavior remain.
No dependencies, installation hooks or network destinations are added.
