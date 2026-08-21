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
  - wsl
status: implemented
related:
  - ./security-scan.md
  - ./review-plan.md
  - ../architecture.md
updated: 2026-08-21
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


## SPEC-CODEX-WSL-RUNTIME: codex CLI の起動先 runtime を選ぶ

Windows版codexはtool実行のたびに `CreateProcessWithLogonW` で `CodexSandboxOffline` の
logon sessionを作り、それを解放しない (upstream openai/codex #33356 / #35940、いずれも未修正)。
審査1本あたり約260個のlsass handleが積み上がり、再起動でしか回収できない。Linux版codexに
この機構は無いため、WSL内のcodexへ差し替えるとleak源ごと消える。

`src/codex-runtime.mjs` はこの選択だけを持つ。規則は次のとおり。

1. 既定は `native` で、`REVISOR_CODEX_RUNTIME` を設定しないhostの挙動は1バイトも変えない。
   `runNamedCli` と同じ経路をそのまま通る。
2. `REVISOR_CODEX_RUNTIME=wsl` のとき、**`codex` という名前のCLIだけ** を
   `wsl.exe -d <distro> -u <user> -- bash -lc "cd <converted cwd> && <binary> <argv>"` へ
   差し替える。`claude` など他のreviewer CLIは影響を受けない。
3. `codex-security` は対象外。WSL内の `codex-security` は `/mnt/c/...` のWindows版しか
   解決できず (Linux版が未導入)、切替えるとscanが走らなくなる。
   [`security-scan.md`](./security-scan.md) の経路は `runNamedCli` を直接使い続ける。
4. runtimeの綴りが `native` / `wsl` のどちらでもなければ **失敗させる**。nativeへ落として
   黙ってleakを続けるより、審査を止めて気付かせる方が損失が小さい。切替の目的がleak停止
   そのものなので「設定したつもりで効いていない」が最悪の状態になる。
5. cwdは絶対driveパス (`E:\...`) だけを `/mnt/<drive>/...` へ変換する。UNC・相対パスは
   WSL側に対応する場所が無く、黙って別の場所を指すより失敗させる。
6. hostの環境変数はWSLへ1つも持ち込まない。WindowsのPATHやTEMPはWSL側で意味を成さず、
   codexの認証はWSL内の `~/.codex/auth.json` が持つため転送すべきものが無い。
   `wsl.exe` へ渡すenvは `PATH` などlauncher解決に要る変数だけへ絞り、`WSLENV` は
   明示的に空へ落とす。host envをそのまま渡すと、host側に `WSLENV` が設定されている
   場合に限りそこへ列挙された変数がWSLへ越境する。`WSLENV` は他のWindows toolingが
   設定していることがありRevisorは関知していないので、越境しない前提を偶然に頼らず
   境界側で閉じる。
7. WSL内binaryの既定は `$HOME/.local/bin/codex` とする。裸の `codex` はWSLのPATHに
   混ざる `/mnt/c/.../npm/codex` (Windows版) を掴むことがあり、それではleakが続く。
   ただし `~` / `$HOME` 始まりのbinaryだけはshellに展開させる。全体をsingle quoteで
   括るとbashは literal な `$HOME` というdirectoryを探し、既定値のままのhostでは
   必ず起動に失敗する。展開するのはprefixのみで、残りのpathは引用したままにする。
8. runtime=wsl が非Windows hostで設定されていたら **失敗させる**。`wsl.exe` はWindows
   にしか無く、nativeへ落とすのは規則4と同じ「設定したつもりで効いていない」状態。

Concordiaは委託経路に対して同じ切替を持つ (`CONCORDIA_SATELLES_CODEX_RUNTIME`)。この
domainが持つのはRevisorの審査経路側で、両者は独立に設定する。
