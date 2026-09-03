import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  claudeSessionCapacityUnavailable,
  claudeSessionLogPath,
} from "../src/claude-capacity.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const SESSION_ID = "4750bf36-ad78-48b3-9299-dbab7717bf9d";

test("detects a structured Claude rate-limit event for the owned session", async () => {
  const home = mkdtempSync(join(tmpdir(), "revisor-claude-capacity-"));
  try {
    const path = claudeSessionLogPath({
      cwd: "C:\\work\\review-head",
      sessionId: SESSION_ID,
      home,
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ type: "system" }),
      JSON.stringify({ type: "assistant", error: "rate_limit", apiErrorStatus: 429 }),
    ].join("\n"), "utf8");

    assert.equal(await claudeSessionCapacityUnavailable({
      cwd: "C:\\work\\review-head",
      sessionId: SESSION_ID,
      home,
    }), true);
  } finally {
    removeFixture(home);
  }
});

test("does not infer capacity exhaustion when the owned session log is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "revisor-claude-capacity-"));
  try {
    assert.equal(await claudeSessionCapacityUnavailable({
      cwd: "C:\\work\\review-head",
      sessionId: SESSION_ID,
      home,
    }), false);
  } finally {
    removeFixture(home);
  }
});
