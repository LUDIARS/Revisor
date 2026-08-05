import assert from "node:assert/strict";
import test from "node:test";
import {
  validateManualRelease,
  validateVersionInitialization,
} from "../src/release-contracts.mjs";

test("requires explicit confirmation for bootstrap and immediate publication", () => {
  assert.throws(
    () => validateVersionInitialization({ version: "0.8.0" }),
    /explicitly confirmed/,
  );
  assert.deepEqual(
    validateVersionInitialization({ version: "0.8.0", confirm: true }),
    { version: "0.8.0" },
  );
  assert.throws(
    () => validateManualRelease({
      kind: "major",
      expectedVersion: "1.4.8",
      title: "2.0",
      notes: "Notes",
    }),
    /explicitly confirmed/,
  );
  assert.deepEqual(
    validateManualRelease({
      kind: "major",
      expectedVersion: "1.4.8",
      title: "2.0",
      notes: "Breaking changes.",
      confirm: true,
    }),
    {
      kind: "major",
      expectedVersion: "1.4.8",
      title: "2.0",
      notes: "Breaking changes.",
    },
  );
});
