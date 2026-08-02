import assert from "node:assert/strict";
import test from "node:test";
import { runNamedCli } from "../src/process.mjs";

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
