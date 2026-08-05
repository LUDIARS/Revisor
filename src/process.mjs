import { spawn } from "node:child_process";
import { isGitCommand, managedGitInvocation } from "./git-runtime.mjs";

export async function runProcess({
  command,
  args,
  cwd,
  stdin = "",
  timeoutMs = 10 * 60_000,
  env = process.env,
}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let invocation = { command, args, env };
    try {
      if (isGitCommand(command)) invocation = managedGitInvocation(args, { cwd, env });
    } catch (error) {
      resolve({ ok: false, stdout, stderr: error.message, exitCode: null });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: invocation.env,
      windowsHide: true,
      shell: false,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be exiting; timeout remains the reported result.
      }
      finish({
        ok: false,
        stdout,
        stderr: `${stderr}\nprocess timed out`,
        exitCode: null,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ ok: false, stdout, stderr: error.message, exitCode: null });
    });
    child.on("close", (exitCode) => {
      finish({ ok: exitCode === 0, stdout, stderr, exitCode });
    });
    child.stdin.end(stdin, "utf8");
  });
}

// `env` is optional and defaults to the service environment: a caller that only
// needs to add one variable must not have to reconstruct PATH (and ComSpec on
// Windows), because a CLI launched without them cannot be found at all.
export async function runNamedCli({ name, args, cwd, stdin, timeoutMs, env = process.env }) {
  if (process.platform === "win32") {
    // npm-installed CLIs are .cmd shims on Windows. cmd.exe is required to
    // launch them; the command name and arguments are Revisor-owned constants.
    return runProcess({
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", name, ...args],
      cwd,
      stdin,
      timeoutMs,
      env,
    });
  }
  return runProcess({
    command: name,
    args,
    cwd,
    stdin,
    timeoutMs,
    env,
  });
}
