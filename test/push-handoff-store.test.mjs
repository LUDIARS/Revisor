import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushHandoffStore } from "../src/push-handoff-store.mjs";

test("handoff attempt survives reopen and a second claimant cannot overwrite it", () => {
  const directory = mkdtempSync(join(tmpdir(), "rv-handoff-"));
  const path = join(directory, "revisor.db");
  let first, second;
  try {
    first = new PushHandoffStore(path);
    assert.equal(first.create({ id: "operation", reason: "replace" }, "session", "digest", "2026-09-13T00:00:00Z"), true);
    first.transition("operation", "awaiting_approval", "attempting", {}, "2026-09-13T00:01:00Z");
    first.close(); first = null;
    second = new PushHandoffStore(path);
    assert.equal(second.create({ id: "operation", reason: "changed" }, "other", "different", "later"), false);
    assert.equal(second.find("operation").status, "attempting");
    assert.equal(second.find("operation").digest, "digest");
    assert.throws(() => second.transition("operation", "approved", "attempting", {}, "later"), /ownership changed/);
  } finally { first?.close(); second?.close(); rmSync(directory, { recursive: true, force: true }); }
});
