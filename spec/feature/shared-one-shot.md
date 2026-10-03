# Shared review CLI launch boundary

Revisor uses the pinned lib/lapilli submodule and @ludiars/one-shot for native Claude print/Codex exec jobs. Generic processes (git, npm, node, codex-security) remain on their existing execution path. The runtime-execution supporting domain owns capture, stdin error handling, timeout and returned status. Reviewer policy continues to own purpose, selected model, sandbox and effort; explicit purpose-specific model IDs are preserved.

Native one-shot launches resolve the actual CLI without cmd.exe and clean API billing/parent coordination environment in the shared boundary. Preparation errors return a failed process result. Existing generic subprocess environment forwarding remains unchanged.

WSL remains opt-in with existing distro/user/binary and strict host environment allowlist. Its login shell runs Linux Node >=22.12 with the mounted shared CLI entry point; the shared library then launches Linux Codex with WSL saved credentials. Missing Linux Node/library/auth is a visible failure, never native fallback. No host credentials cross into WSL. The library path and all job arguments are shell-quoted. The existing WSL launcher timeout is preserved; no claim is made that killing wsl.exe guarantees termination of all Linux descendants.

Setup requires submodule update --init -- lib/lapilli and npm install. Ship lib/lapilli/packages/one-shot with Revisor including its src tree. No service restart, live reviewer call, sandbox change, retry or permission bypass is introduced. Restore by reverting this boundary and dependency together. Verification uses syntax checks locally and existing process/WSL registered tests in Revisor, augmented with shared-launch preparation failure and quoted library-path assertions.
