import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  isGitCommand,
  managedGitInvocation,
  managedGitPaths,
  resolveManagedGitRoot,
} from "../src/git-runtime.mjs";

const ROOT = "C:\\managed\\revisor\\git";
const ENV = { LOCALAPPDATA: "C:\\managed", REVISOR_GIT_ROOT: ROOT, AUTH_HEADER: "secret" };
const KEEP_ENV = ({ env }) => env;

function completeRuntime(path) {
  const portable = path.replaceAll("\\", "/");
  return portable.endsWith("cmd/git.exe");
}

test("launches the Revisor-owned Windows Git directly and preserves argv and env", () => {
  const invocation = managedGitInvocation(["-C", "repo with spaces", "status"], {
    cwd: "C:\\review worktree",
    env: ENV,
    platform: "win32",
    fileExists: completeRuntime,
    trustEnv: KEEP_ENV,
  });

  const paths = managedGitPaths(ROOT);
  assert.equal(invocation.command, paths.git);
  assert.deepEqual(invocation.args.slice(0, 2), [
    "-c",
    `safe.directory=${resolve("C:\\review worktree").replaceAll("\\", "/")}`,
  ]);
  assert.deepEqual(invocation.args.slice(2), ["-C", "repo with spaces", "status"]);
  assert.equal(invocation.env, ENV);
});

test("hands Git the Revisor trust configuration through the environment", () => {
  let safeDirectories;
  const invocation = managedGitInvocation([
    "-c",
    "safe.directory=C:/registered/Product/.git",
    "fetch",
  ], {
    cwd: "C:\\review worktree",
    env: ENV,
    platform: "win32",
    fileExists: completeRuntime,
    trustEnv: (request) => {
      safeDirectories = request.safeDirectories;
      return { ...request.env, GIT_CONFIG_GLOBAL: "C:\\managed\\trust.gitconfig" };
    },
  });

  assert.deepEqual(safeDirectories, ["C:/registered/Product/.git"]);
  assert.equal(invocation.env.GIT_CONFIG_GLOBAL, "C:\\managed\\trust.gitconfig");
  assert.equal(invocation.env.AUTH_HEADER, "secret");
});

test("refuses a SourceTree runtime even when explicitly configured", () => {
  assert.throws(
    () => resolveManagedGitRoot({
      env: { REVISOR_GIT_ROOT: "C:\\Users\\me\\AppData\\Local\\Atlassian\\SourceTree\\git_local" },
      platform: "win32",
      fileExists: () => true,
    }),
    /refuses the SourceTree Git runtime/,
  );
});

test("recognizes Git executable paths without treating other commands as Git", () => {
  assert.equal(isGitCommand("git", { platform: "win32" }), true);
  assert.equal(isGitCommand("C:\\tools\\git.exe", { platform: "win32" }), true);
  assert.equal(isGitCommand("C:\\tools\\github.exe", { platform: "win32" }), false);
});

test("fails closed when the managed runtime is incomplete", () => {
  assert.throws(
    () => resolveManagedGitRoot({ env: ENV, platform: "win32", fileExists: () => false }),
    /managed Git is incomplete/,
  );
});

test("uses the configured Revisor Git binary on non-Windows hosts", () => {
  const env = { REVISOR_GIT_BIN: "/opt/revisor/bin/git" };
  assert.deepEqual(
    managedGitInvocation(["status"], {
      cwd: "/review/worktree",
      env,
      platform: "linux",
      trustEnv: KEEP_ENV,
    }),
    {
      command: "/opt/revisor/bin/git",
      args: [
        "-c",
        `safe.directory=${resolve("/review/worktree").replaceAll("\\", "/")}`,
        "status",
      ],
      env,
    },
  );
});
