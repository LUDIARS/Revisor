import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLockHeld, tryAcquireLock } from "../src/file-lock.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

test("a live lock does not expire solely because a review runs for more than two minutes", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-lock-"));
  const path = join(directory, "worker");
  try {
    const release = tryAcquireLock(path, { now: () => 1 });
    assert.equal(typeof release, "function");
    assert.equal(isLockHeld(path), true);
    assert.equal(tryAcquireLock(path), null);
    release();
  } finally {
    removeFixture(directory);
  }
});

test("an old release callback cannot remove a replacement owner's lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-lock-owner-"));
  const path = join(directory, "worker");
  const lockDirectory = `${path}.lock`;
  try {
    const release = tryAcquireLock(path);
    const ownerPath = join(lockDirectory, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "replacement" }), "utf8");
    release();
    assert.equal(existsSync(lockDirectory), true);
  } finally {
    removeFixture(directory);
  }
});
