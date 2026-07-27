import { spawn } from "node:child_process";

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
    const child = spawn(command, args, {
      cwd,
      env,
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

export async function runNamedCli({ name, args, cwd, stdin, timeoutMs }) {
  if (process.platform === "win32") {
    // npm-installed CLIs are .cmd shims on Windows. cmd.exe is required to
    // launch them; the command name and arguments are Revisor-owned constants.
    return runProcess({
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", name, ...args],
      cwd,
      stdin,
      timeoutMs,
    });
  }
  return runProcess({
    command: name,
    args,
    cwd,
    stdin,
    timeoutMs,
  });
}
