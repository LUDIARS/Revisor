import assert from "node:assert/strict";
import test from "node:test";
import { runPushHandoffCommand } from "../src/push-handoff-command.mjs";

test("ordinary branch pushes stay on the existing route", async () => {
  assert.equal(await runPushHandoffCommand(["push", "--branch", "feature"]), null);
});

test("handoff forbids conflicting branch options before reading a file or opening state", async () => {
  for (const flag of ["--branch", "--remote-branch", "--repo", "--actor", "--force-with-lease"]) {
    await assert.rejects(runPushHandoffCommand(["push", "--handoff", "missing.json", flag, "value"]), /cannot be combined/);
  }
  await assert.rejects(runPushHandoffCommand(["push", "--handoff", "missing.json"]), /requires/);
});
