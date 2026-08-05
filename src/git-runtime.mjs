import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const WINDOWS_GIT_SCRIPT = [
  "export PATH=/usr/bin:/mingw64/bin:/mingw64/libexec/git-core:\"$PATH\"",
  "exec \"$0\" \"$@\"",
].join("; ");

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
    shell: join(root, "usr", "bin", "sh.exe"),
    setup: join(root, "mingw64", "libexec", "git-core", "git-sh-setup"),
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
  const missing = [paths.git, paths.shell, paths.setup].filter((path) => !fileExists(path));
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
} = {}) {
  const managedArgs = cwd
    ? ["-c", `safe.directory=${resolve(cwd).replaceAll("\\", "/")}`, ...args]
    : args;
  if (platform !== "win32") {
    return {
      command: env.REVISOR_GIT_BIN || "git",
      args: managedArgs,
      env,
    };
  }

  const paths = resolveManagedGitRoot({ env, platform, fileExists });
  return {
    command: paths.shell,
    args: ["-c", WINDOWS_GIT_SCRIPT, paths.git, ...managedArgs],
    env,
  };
}
