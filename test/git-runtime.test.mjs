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

function completeRuntime(path) {
  const portable = path.replaceAll("\\", "/");
  return portable.endsWith("cmd/git.exe")
    || portable.endsWith("usr/bin/sh.exe")
    || portable.endsWith("mingw64/libexec/git-core/git-sh-setup");
}

test("wraps Windows Git with the Revisor-owned shell and preserves argv and env", () => {
  const invocation = managedGitInvocation(["-C", "repo with spaces", "status"], {
    cwd: "C:\\review worktree",
    env: ENV,
    platform: "win32",
    fileExists: completeRuntime,
  });

  const paths = managedGitPaths(ROOT);
  assert.equal(invocation.command, paths.shell);
  assert.deepEqual(invocation.args.slice(-3), ["-C", "repo with spaces", "status"]);
  assert.equal(invocation.args[2], paths.git);
  assert.deepEqual(invocation.args.slice(3, 5), [
    "-c",
    `safe.directory=${resolve("C:\\review worktree").replaceAll("\\", "/")}`,
  ]);
  assert.match(invocation.args[1], /mingw64\/libexec\/git-core/);
  assert.equal(invocation.env, ENV);
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
    managedGitInvocation(["status"], { cwd: "/review/worktree", env, platform: "linux" }),
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
