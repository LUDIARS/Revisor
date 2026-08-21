import { RevisorError } from "./errors.mjs";
import { runNamedCli, runProcess } from "./process.mjs";

// Windows 版 codex はツール実行のたびに `CreateProcessWithLogonW` で
// `CodexSandboxOffline` のログオンセッションを作り、それを解放しない
// (upstream openai/codex #33356 / #35940、いずれも未修正)。審査 1 本あたり
// 約 260 個の lsass ハンドルが積み上がり、再起動でしか回収できない。Linux 版
// codex にこの機構は無いので、WSL 内の codex へ差し替えるとリーク源ごと消える。
// Concordia が委託経路に対して同じ切替を持っている
// (CONCORDIA_SATELLES_CODEX_RUNTIME) が、Revisor の審査経路はその配線の外に
// あったため、実運用の codex セッションはほぼ全量が Windows 版のままだった。
const RUNTIMES = new Set(["native", "wsl"]);

const RUNTIME_ENV = "REVISOR_CODEX_RUNTIME";
const DISTRO_ENV = "REVISOR_CODEX_WSL_DISTRO";
const USER_ENV = "REVISOR_CODEX_WSL_USER";
const BINARY_ENV = "REVISOR_CODEX_WSL_BINARY";

// `wsl.exe` を Windows 側で解決・起動するために必要な変数だけを残す。
// これらを落とすと launcher そのものが見つからなくなる。
const WSL_LAUNCHER_ENV_KEYS = ["PATH", "Path", "SystemRoot", "SystemDrive", "windir", "ComSpec"];

// `E:\path` / `E:/path` のドライブ絶対パスだけを変換対象にする。UNC・相対パス
// は WSL 側に対応する場所が無く、黙って別の場所を指すより失敗させる方が安全。
const DRIVE_ABSOLUTE_PATTERN = /^([A-Za-z]):[\\/](.*)$/;

/** @implements SPEC-CODEX-WSL-RUNTIME */
function trimmed(env, key) {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

// runtime の綴り間違いは native へ落として黙ってリークを続けるより、審査を
// 失敗させて気付かせる方がよい。切替の目的がリーク停止そのものなので、
// 「設定したつもりで効いていない」が一番損な状態になる。
/** @implements SPEC-CODEX-WSL-RUNTIME */
export function codexRuntimeConfig(env = process.env) {
  const runtime = trimmed(env, RUNTIME_ENV) || "native";
  if (!RUNTIMES.has(runtime)) {
    throw new RevisorError(
      `invalid ${RUNTIME_ENV}: '${runtime}' (must be native or wsl).`,
    );
  }
  return {
    runtime,
    distro: trimmed(env, DISTRO_ENV) || "Ubuntu",
    user: trimmed(env, USER_ENV) || "ubuntu",
    // 既定を裸の `codex` にすると、WSL の PATH に混ざっている
    // `/mnt/c/.../npm/codex` (Windows 版) を掴んでリークが続くことがある。
    // Linux 版だけを指す絶対パスを既定にして、事故の方向を閉じる。
    binary: trimmed(env, BINARY_ENV) || "$HOME/.local/bin/codex",
  };
}

/** @implements SPEC-CODEX-WSL-RUNTIME */
export function windowsPathToWslPath(windowsPath) {
  const match = DRIVE_ABSOLUTE_PATTERN.exec(windowsPath);
  if (!match) {
    throw new RevisorError(
      `unsupported path for WSL conversion (expected an absolute drive path like 'E:\\\\work'): ${windowsPath}`,
    );
  }
  const drive = match[1].toLowerCase();
  const rest = match[2]
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join("/");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

// `~` / `$HOME` 始まりの binary だけは展開させたいので、引用の対象から外して
// 残りの path 部分だけを引用する。既定値が `$HOME/.local/bin/codex` である以上、
// 全体を引用すると literal な `$HOME` ディレクトリを探して必ず起動に失敗する。
const HOME_PREFIX_PATTERN = /^(~|\$HOME|\$\{HOME\})(\/.*)?$/;

/** @implements SPEC-CODEX-WSL-RUNTIME */
export function quoteWslBinary(binary) {
  const match = HOME_PREFIX_PATTERN.exec(binary);
  if (!match) return posixShellQuote(binary);
  const rest = match[2] ?? "";
  return rest ? `"$HOME"${posixShellQuote(rest)}` : `"$HOME"`;
}

// POSIX シェルのシングルクォート引用。`bash -lc` に渡す文字列は WSL 内で
// 再解釈されるので、cwd もモデル名も引用してからでないと argv 境界が崩れる。
/** @implements SPEC-CODEX-WSL-RUNTIME */
export function posixShellQuote(value) {
  if (/[\0\r\n]/.test(value)) {
    throw new RevisorError(
      "unsafe control character in a value passed to the WSL shell.",
    );
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `wsl.exe` へ渡す Windows 側 env を組み立てる。
 *
 * host の env をそのまま渡すと、host に `WSLENV` が設定されている場合に限り
 * そこへ列挙された変数が WSL 側へ越境する (`WSLENV` は他の Windows tooling が
 * 設定していることがあり、Revisor は関知していない)。規則 6 は「host の環境変数
 * を WSL へ 1 つも持ち込まない」なので、`WSLENV` を明示的に空にし、残すのは
 * `wsl.exe` 自体の解決に要る launcher 変数だけにする。WSL 内の環境は
 * `bash -lc` のログインシェルが用意する。
 *
 * @implements SPEC-CODEX-WSL-RUNTIME
 */
export function wslLauncherEnv(env) {
  const launcher = {};
  for (const key of WSL_LAUNCHER_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") launcher[key] = value;
  }
  // 空文字は「WSLENV 未設定」と同じ扱いになり、host 変数の越境を止める。
  launcher.WSLENV = "";
  return launcher;
}

/**
 * `wsl.exe` の argv を組み立てる純関数 (`wsl.exe` は起動しない)。
 *
 * argv 側では WSL 内の環境を一切指定しない。codex の認証は WSL 内の
 * `~/.codex/auth.json` が持っており、PATH は `bash -lc` のログインシェルが
 * nvm 込みで張るため、渡すべきものが無い (host env の遮断は
 * `wslLauncherEnv` が担当する)。
 *
 * @implements SPEC-CODEX-WSL-RUNTIME
 */
export function buildWslCodexArgs({ args, cwd, config }) {
  const command = [
    `cd ${posixShellQuote(windowsPathToWslPath(cwd))} &&`,
    quoteWslBinary(config.binary),
    ...args.map((arg) => posixShellQuote(arg)),
  ].join(" ");
  return ["-d", config.distro, "-u", config.user, "--", "bash", "-lc", command];
}

/**
 * 名前付き CLI を起動する。`codex` かつ runtime=wsl のときだけ WSL 経由に
 * 差し替え、それ以外は `runNamedCli` と完全に同じ経路を通る。
 *
 * `codex-security` は対象外。WSL 内の `codex-security` は `/mnt/c/...` の
 * Windows 版しか解決できず (Linux 版が未導入)、切替えると走らなくなる。
 *
 * `wsl.exe` は Windows host にしか存在しない。runtime=wsl が非 Windows で
 * 設定されていたら、綴り間違いと同じ理由で失敗させる。native へ落とすと
 * 「設定したつもりで効いていない」状態を黙って作ってしまう。
 *
 * @implements SPEC-CODEX-WSL-RUNTIME
 */
export async function runCodexAwareCli(
  { name, args, cwd, stdin, timeoutMs, env = process.env },
  { runCli = runNamedCli, runProc = runProcess, platform = process.platform } = {},
) {
  const config = codexRuntimeConfig(env);
  if (name !== "codex" || config.runtime !== "wsl") {
    return runCli({ name, args, cwd, stdin, timeoutMs, env });
  }
  if (platform !== "win32") {
    throw new RevisorError(
      `${RUNTIME_ENV}=wsl requires a Windows host (wsl.exe), but the platform is '${platform}'.`,
    );
  }
  return runProc({
    command: "wsl.exe",
    args: buildWslCodexArgs({ args, cwd, config }),
    cwd,
    stdin,
    timeoutMs,
    env: wslLauncherEnv(env),
  });
}
