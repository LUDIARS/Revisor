---
type: feature
title: "runtime-execution — policy-neutral child-process boundary"
description: "Revisor adaptersが利用する子プロセス起動、出力捕捉、timeout終了、Windows shim、呼出単位env転送の共通境界。個別CLIのpolicyや環境変数の意味は持たない。"
service: revisor
domain: runtime-execution
tags:
  - child-process
  - timeout
  - environment
status: implemented
related:
  - ./security-scan.md
  - ../architecture.md
updated: 2026-08-02
---

# runtime-execution — policy-neutral child-process boundary

`src/process.mjs` はRevisor内の外部CLI adapterが共有する、policy-neutralな実行primitiveを
提供する。責務は次に限定する。

- shell文字列ではなく実行ファイルとargvを分離して起動する
- stdout/stderrを捕捉し、timeout時は所有する子プロセスを終了する
- Windowsのnpm shim起動差を吸収する
- 呼出側が指定した任意の `env` を子プロセスへ渡し、省略時はサービス環境を維持する

環境変数の意味、作成・削除する一時resource、終了コードのdomain上の解釈は呼出側が所有する。
たとえば `CODEX_SECURITY_STATE_DIR` の隔離とcleanupは
[`security-scan.md`](./security-scan.md) の責務であり、このdomainは変数名を解釈しない。

この境界により、`review-gate` のsecurity policyが汎用process primitiveへ逆流せず、
CI・Anatomia・reviewerなど他adapterも同じprocess lifecycle実装を再利用できる。

`env` の転送は `test/process.test.mjs` が実際に子プロセスを起動して確認する。
adapter側のtestは `execute` をstubするため、`runNamedCli` / `runProcess` が `env` を
落としても気付けない (scanごとのstate隔離が黙って共有dirへ戻る) 唯一の箇所だから。
