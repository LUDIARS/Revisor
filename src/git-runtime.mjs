import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { gitTrustEnv } from "./git-trust.mjs";

function defaultWindowsGitRoot(env) {
  if (!env.LOCALAPPDATA) {
    throw new Error(
      "Revisor managed Git is not configured: LOCALAPPDATA and REVISOR_GIT_ROOT are both missing.",
    );
  }
  return join(env.LOCALAPPDATA, "LUDIARS", "Revisor", "git");
}

function rejectsSourceTree(root) {
  const portable = normalize(root).replaceAll("\\", "/").toLowerCase();
  return portable.includes("/atlassian/sourcetree/");
}

export function assertSupportedGitRoot(root) {
  if (rejectsSourceTree(root)) {
    throw new Error(`Revisor refuses the SourceTree Git runtime: ${root}`);
  }
}

export function isGitCommand(command, { platform = process.platform } = {}) {
  if (typeof command !== "string") return false;
  const portable = command.replaceAll("\\", "/");
  const name = portable.slice(portable.lastIndexOf("/") + 1).toLowerCase();
  return name === "git" || (platform === "win32" && name === "git.exe");
}

export function managedGitPaths(root) {
  return {
    root,
    git: join(root, "cmd", "git.exe"),
  };
}

export function resolveManagedGitRoot({
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  if (platform !== "win32") return null;

  const root = env.REVISOR_GIT_ROOT || defaultWindowsGitRoot(env);
  assertSupportedGitRoot(root);

  const paths = managedGitPaths(root);
  const missing = [paths.git].filter((path) => !fileExists(path));
  if (missing.length > 0) {
    throw new Error(
      `Revisor managed Git is incomplete at ${root}; missing: ${missing.join(", ")}. `
      + "Run npm run install:git -- --source <complete Git for Windows root>.",
    );
  }
  return paths;
}

export function managedGitInvocation(args, {
  cwd,
  env = process.env,
  platform = process.platform,
  fileExists = existsSync,
  trustEnv = gitTrustEnv,
} = {}) {
  // `-c safe.directory` が守れるのは、 この git プロセス自身が開くリポジトリ (cwd) だけ。
  // local clone の取得元は子プロセスの `upload-pack` が開くため command-line scope が
  // 届かない。 そちらは GIT_CONFIG_GLOBAL 経由の信頼設定が担う (src/git-trust.mjs)。
  const managedArgs = cwd
    ? ["-c", `safe.directory=${resolve(cwd).replaceAll("\\", "/")}`, ...args]
    : args;
  const sourceSafeDirectories = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") continue;
    const value = args[index + 1];
    if (typeof value === "string" && value.startsWith("safe.directory=")) {
      sourceSafeDirectories.push(value.slice("safe.directory=".length));
    }
  }
  const trustedEnv = trustEnv({
    env,
    platform,
    safeDirectories: sourceSafeDirectories,
  });
  if (platform !== "win32") {
    return {
      command: env.REVISOR_GIT_BIN || "git",
      args: managedArgs,
      env: trustedEnv,
    };
  }

  const paths = resolveManagedGitRoot({ env, platform, fileExists });
  return {
    command: paths.git,
    args: managedArgs,
    env: trustedEnv,
  };
}
