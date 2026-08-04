import assert from "node:assert/strict";
import test from "node:test";
import { composeReleaseNotes } from "../src/release-notes.mjs";

const pullRequest = {
  number: 42,
  title: "Ship the next release line",
  body: "Upgrade notes for operators.",
};

test("adds a tag comparison to major and minor GitHub Releases", () => {
  const notes = composeReleaseNotes(pullRequest, "abc123", {
    repository: "LUDIARS/Product",
    tag: "v2.0.0",
    previousTag: "v1.8.4",
    kind: "major",
  });

  assert.match(notes, /## Major version release/);
  assert.match(notes, /Version transition: `v1\.8\.4` → `v2\.0\.0`/);
  assert.match(
    notes,
    /https:\/\/github\.com\/LUDIARS\/Product\/compare\/v1\.8\.4\.\.\.v2\.0\.0/,
  );
});

test("keeps patch Release notes focused on the local PR", () => {
  const notes = composeReleaseNotes(pullRequest, "abc123", {
    repository: "LUDIARS/Product",
    tag: "v1.8.5",
    previousTag: "v1.8.4",
    kind: "patch",
  });

  assert.doesNotMatch(notes, /version release/);
  assert.doesNotMatch(notes, /\/compare\//);
});
