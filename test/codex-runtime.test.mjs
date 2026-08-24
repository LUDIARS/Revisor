import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWslCodexArgs,
  codexRuntimeConfig,
  codexSandboxArgs,
  codexSandboxMode,
  posixShellQuote,
  quoteWslBinary,
  runCodexAwareCli,
  windowsPathToWslPath,
  wslLauncherEnv,
} from "../src/codex-runtime.mjs";

test("defaults to the native runtime so an unconfigured host is unchanged", () => {
  assert.deepEqual(codexRuntimeConfig({}), {
    runtime: "native",
    distro: "Ubuntu",
    user: "ubuntu",
    binary: "$HOME/.local/bin/codex",
  });
  assert.deepEqual(codexRuntimeConfig({ REVISOR_CODEX_RUNTIME: "  " }).runtime, "native");
});

test("reads every WSL knob from the environment", () => {
  assert.deepEqual(codexRuntimeConfig({
    REVISOR_CODEX_RUNTIME: "wsl",
    REVISOR_CODEX_WSL_DISTRO: "Debian",
    REVISOR_CODEX_WSL_USER: "dev",
    REVISOR_CODEX_WSL_BINARY: "/usr/local/bin/codex",
  }), {
    runtime: "wsl",
    distro: "Debian",
    user: "dev",
    binary: "/usr/local/bin/codex",
  });
});

// A misspelled runtime must not fall back to native: the whole point of the
// switch is to stop the lsass leak, so "configured but silently not applied"
// is the one outcome that has to be impossible.
test("rejects an unknown runtime instead of falling back to native", () => {
  assert.throws(
    () => codexRuntimeConfig({ REVISOR_CODEX_RUNTIME: "WSL2" }),
    /invalid REVISOR_CODEX_RUNTIME: 'WSL2'/,
  );
});

test("converts absolute drive paths to /mnt paths", () => {
  assert.equal(
    windowsPathToWslPath("E:\\Document\\Ars\\Revisor"),
    "/mnt/e/Document/Ars/Revisor",
  );
  assert.equal(
    windowsPathToWslPath("C:/Users/raury/work/head"),
    "/mnt/c/Users/raury/work/head",
  );
  assert.equal(windowsPathToWslPath("D:\\"), "/mnt/d");
  assert.equal(
    windowsPathToWslPath("E:\\a\\\\b//c"),
    "/mnt/e/a/b/c",
  );
});

test("refuses paths that have no WSL equivalent", () => {
  assert.throws(() => windowsPathToWslPath("\\\\server\\share"), /unsupported path/);
  assert.throws(() => windowsPathToWslPath("relative/path"), /unsupported path/);
});

test("quotes values for the WSL shell and refuses control characters", () => {
  assert.equal(posixShellQuote("plain"), "'plain'");
  assert.equal(posixShellQuote("it's"), "'it'\\''s'");
  assert.throws(() => posixShellQuote("a\nb"), /unsafe control character/);
});

test("builds a wsl.exe argv that cds into the converted worktree", () => {
  const args = buildWslCodexArgs({
    args: ["exec", "--model", "gpt-5.6-terra", "--sandbox", "workspace-write", "-"],
    cwd: "E:\\Document\\Ars\\work\\head",
    config: {
      runtime: "wsl",
      distro: "Ubuntu",
      user: "ubuntu",
      binary: "$HOME/.local/bin/codex",
    },
  });
  assert.deepEqual(args, [
    "-d",
    "Ubuntu",
    "-u",
    "ubuntu",
    "--",
    "bash",
    "-lc",
    "cd '/mnt/e/Document/Ars/work/head' && \"$HOME\"'/.local/bin/codex' 'exec' '--model' "
      + "'gpt-5.6-terra' '--sandbox' 'workspace-write' '-'",
  ]);
});

// The default binary is `$HOME/.local/bin/codex`. Single-quoting it whole would
// make bash look for a literal `$HOME` directory, so the WSL switch would fail
// to launch on every host that leaves the binary at its default.
test("expands a $HOME-relative binary instead of quoting it into a literal", () => {
  assert.equal(quoteWslBinary("$HOME/.local/bin/codex"), "\"$HOME\"'/.local/bin/codex'");
  assert.equal(quoteWslBinary("${HOME}/.local/bin/codex"), "\"$HOME\"'/.local/bin/codex'");
  assert.equal(quoteWslBinary("~/.local/bin/codex"), "\"$HOME\"'/.local/bin/codex'");
  assert.equal(quoteWslBinary("~"), "\"$HOME\"");
});

// An absolute binary must stay fully quoted: nothing in it should be re-read by
// the shell, so a path containing a space or a `$` still resolves verbatim.
test("fully quotes an absolute binary path", () => {
  assert.equal(quoteWslBinary("/usr/local/bin/codex"), "'/usr/local/bin/codex'");
  assert.equal(quoteWslBinary("/opt/my codex/bin"), "'/opt/my codex/bin'");
  assert.equal(quoteWslBinary("/opt/$EVIL/codex"), "'/opt/$EVIL/codex'");
});

// Rule 6 says no host variable crosses into WSL. Forwarding the host env
// verbatim would honour that only while `WSLENV` happens to be unset, and
// `WSLENV` is set by other Windows tooling that Revisor does not control — so
// the boundary has to be closed here rather than assumed.
test("passes wsl.exe only the launcher variables and neutralises WSLENV", () => {
  assert.deepEqual(
    wslLauncherEnv({
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      WSLENV: "SECRET_TOKEN/u",
      SECRET_TOKEN: "s3cret",
      GITHUB_TOKEN: "ghp_example",
      CODEX_SECURITY_STATE_DIR: "C:\\state",
    }),
    {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      WSLENV: "",
    },
  );
  // Absent launcher variables stay absent rather than becoming `undefined`.
  assert.deepEqual(wslLauncherEnv({}), { WSLENV: "" });
});

test("keeps the native path byte-identical when the runtime is not set", async () => {
  let seen = null;
  const result = await runCodexAwareCli({
    name: "codex",
    args: ["exec", "-"],
    cwd: "E:\\work\\head",
    stdin: "review",
    timeoutMs: 1000,
    env: {},
  }, {
    runCli: async (options) => {
      seen = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    runProc: async () => assert.fail("native runtime must not spawn wsl.exe"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, {
    name: "codex",
    args: ["exec", "-"],
    cwd: "E:\\work\\head",
    stdin: "review",
    timeoutMs: 1000,
    env: {},
  });
});

test("routes only codex through WSL, leaving other CLIs on the native path", async () => {
  const env = {
    REVISOR_CODEX_RUNTIME: "wsl",
    PATH: "C:\\Windows\\System32",
    WSLENV: "GITHUB_TOKEN/u",
    GITHUB_TOKEN: "ghp_example",
  };
  let claude = null;
  await runCodexAwareCli({
    name: "claude",
    args: ["--print"],
    cwd: "E:\\work\\head",
    stdin: "review",
    timeoutMs: 1000,
    env,
  }, {
    runCli: async (options) => {
      claude = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    runProc: async () => assert.fail("claude must not be routed through WSL"),
  });
  assert.equal(claude.name, "claude");

  let spawned = null;
  await runCodexAwareCli({
    name: "codex",
    args: ["exec", "-"],
    cwd: "E:\\work\\head",
    stdin: "review",
    timeoutMs: 1000,
    env,
  }, {
    runCli: async () => assert.fail("wsl runtime must not use the cmd.exe shim"),
    runProc: async (options) => {
      spawned = options;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
    platform: "win32",
  });
  assert.equal(spawned.command, "wsl.exe");
  assert.equal(spawned.stdin, "review");
  assert.equal(spawned.timeoutMs, 1000);
  // The Windows cwd stays on the spawn itself; only the shell command is
  // converted, because wsl.exe is launched from Windows.
  assert.equal(spawned.cwd, "E:\\work\\head");
  assert.deepEqual(spawned.args.slice(0, 6), ["-d", "Ubuntu", "-u", "ubuntu", "--", "bash"]);
  assert.match(spawned.args.at(-1), /^cd '\/mnt\/e\/work\/head' && /);
  // Only the launcher variables reach wsl.exe, and WSLENV is neutralised so the
  // host's own WSLENV cannot smuggle GITHUB_TOKEN across the boundary.
  assert.deepEqual(spawned.env, { PATH: "C:\\Windows\\System32", WSLENV: "" });
});

// sandbox 切替は綴り間違いを黙って sandboxed へ落とすと「設定したつもりで
// リーク続行」になるため、runtime と同じく fail-fast を検証する。
test("codexSandboxArgs picks the sandbox flags from REVISOR_CODEX_SANDBOX", () => {
  assert.deepEqual(codexSandboxArgs(false, {}), ["--sandbox", "workspace-write"]);
  assert.deepEqual(codexSandboxArgs(true, {}), ["--sandbox", "read-only"]);
  const env = { REVISOR_CODEX_SANDBOX: "danger-full-access" };
  assert.deepEqual(codexSandboxArgs(false, env, "win32"), ["--sandbox", "danger-full-access"]);
  assert.deepEqual(codexSandboxArgs(true, env, "win32"), ["--sandbox", "danger-full-access"]);
});

test("codexSandboxMode rejects unknown values instead of silently sandboxing", () => {
  assert.throws(
    () => codexSandboxMode({ REVISOR_CODEX_SANDBOX: "full" }),
    /invalid REVISOR_CODEX_SANDBOX/,
  );
});

test("danger-full-access is limited to the affected native Windows runtime", () => {
  const danger = { REVISOR_CODEX_SANDBOX: "danger-full-access" };
  assert.throws(
    () => codexSandboxArgs(false, danger, "linux"),
    /only supported on Windows hosts/,
  );
  assert.throws(
    () => codexSandboxArgs(false, { ...danger, REVISOR_CODEX_RUNTIME: "wsl" }, "win32"),
    /requires REVISOR_CODEX_RUNTIME=native/,
  );
});

// wsl.exe only exists on Windows. Silently falling back to native would recreate
// the exact failure the switch exists to prevent: configured, but not applied.
test("refuses the wsl runtime on a non-Windows host", async () => {
  await assert.rejects(
    () => runCodexAwareCli({
      name: "codex",
      args: ["exec", "-"],
      cwd: "E:\\work\\head",
      stdin: "review",
      timeoutMs: 1000,
      env: { REVISOR_CODEX_RUNTIME: "wsl" },
    }, {
      runCli: async () => assert.fail("must not fall back to the native path"),
      runProc: async () => assert.fail("must not spawn wsl.exe off Windows"),
      platform: "linux",
    }),
    /requires a Windows host/,
  );
});
