import assert from "node:assert/strict";
import test from "node:test";
import { runNamedCli, runProcess } from "../src/process.mjs";

// A real child process is launched here on purpose: every other suite stubs
// `execute`, so the only place the caller-supplied `env` is observed as the
// child's actual environment is a spawn. Dropping `env` on either leg of
// `runNamedCli` (cmd.exe shim or direct) would leave those suites green while
// the scanner silently fell back to the shared state directory.
const PROBE = "REVISOR_ENV_PROBE";
// `node -p <expression>` only: the Windows leg hands the command line to
// cmd.exe, which re-interprets it, so the probe expression carries no spaces
// or shell metacharacters.
const ARGS = ["-p", `process.env.${PROBE}`];
const TIMEOUT_MS = 60_000;

test("forwards a caller-supplied environment to the child process", async () => {
  const result = await runNamedCli({
    name: "node",
    args: ARGS,
    env: { ...process.env, [PROBE]: "from-caller" },
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), "from-caller");
});

test("keeps the service environment when no environment is given", async () => {
  const original = process.env[PROBE];
  process.env[PROBE] = "from-service";
  try {
    const result = await runNamedCli({ name: "node", args: ARGS, timeoutMs: TIMEOUT_MS });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "from-service");
  } finally {
    if (original === undefined) delete process.env[PROBE];
    else process.env[PROBE] = original;
  }
});

test("reports a child closing stdin without crashing or hiding its exit code", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.exit(0)",
    ],
    // Exceed the pipe buffer so input delivery cannot finish before the child
    // closes its read end. The child exits successfully to prove EPIPE alone
    // still makes the command result unsuccessful.
    stdin: "x".repeat(8 * 1024 * 1024),
    timeoutMs: TIMEOUT_MS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /stdin write failed \([^)]+\)/);
});

test("treats a fast command without input as successful (no stdin pipe, no EPIPE)", async () => {
  // git merge-base のように入力を読まずすぐ終わるコマンドを繰り返し起動する。
  // 以前は空の入力を書き込み、子が先に終わると EPIPE で失敗扱いになっていた。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: TIMEOUT_MS,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.doesNotMatch(result.stderr, /stdin write failed/);
  }
});

test("does not hand the parent's input to a command that takes none", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write('eof'))"],
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "eof");
});

test("still delivers input to commands that read it", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "let s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))"],
    stdin: "patch",
    timeoutMs: TIMEOUT_MS,
  });
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.stdout, "PATCH");
});
