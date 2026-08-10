import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLockHeld, tryAcquireLock } from "../src/file-lock.mjs";

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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
  }
});
