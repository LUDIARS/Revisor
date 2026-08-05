import assert from "node:assert/strict";
import test from "node:test";
import { composeReleaseNotes } from "../src/release-notes.mjs";

test("leaves the first human-selected Release without notes", () => {
  assert.equal(composeReleaseNotes({
    repository: "LUDIARS/Product",
    tag: "v1.0.0",
    previousTag: null,
    kind: "initial",
  }), "");
});

test("records every commit since the previous major or minor Release", () => {
  const notes = composeReleaseNotes({
    repository: "LUDIARS/Product",
    tag: "v2.0.0",
    previousTag: "v1.8.0",
    kind: "major",
    changes: [
      { sha: "abc123456789ffff", subject: "Add public API" },
      { sha: "def987654321ffff", subject: "Tighten [validation]" },
    ],
  });

  assert.match(notes, /## Major version release/);
  assert.match(notes, /Version transition: `v1\.8\.0` → `v2\.0\.0`/);
  assert.match(notes, /Add public API \(`abc123456789`\)/);
  assert.match(notes, /Tighten \\[validation\\]/);
  assert.match(
    notes,
    /https:\/\/github\.com\/LUDIARS\/Product\/compare\/v1\.8\.0\.\.\.v2\.0\.0/,
  );
});

test("refuses patch Release notes", () => {
  assert.throws(
    () => composeReleaseNotes({ kind: "patch" }),
    /only for initial, major, or minor/,
  );
});
