import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

test("removes a fixture beneath the OS temporary directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-cleanup-"));
  writeFileSync(join(directory, "fixture.txt"), "fixture\n", "utf8");

  removeFixture(directory);

  assert.equal(existsSync(directory), false);
});

test("refuses to delete the temporary root or a path outside it", () => {
  assert.throws(() => removeFixture(tmpdir()), /restricted to children/);
  assert.throws(() => removeFixture(dirname(tmpdir())), /restricted to children/);
});

test("refuses an invalid cleanup target", () => {
  assert.throws(() => removeFixture(""), /non-empty directory path/);
  assert.throws(() => removeFixture(null), /non-empty directory path/);
});
