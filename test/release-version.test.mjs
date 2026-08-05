import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReleaseKind,
  isReleaseTag,
  selectReleaseTag,
} from "../src/release-version.mjs";

test("classifies sequential release transitions, including retries", () => {
  assert.equal(classifyReleaseKind(null, "v1.0.0"), "initial");
  assert.equal(classifyReleaseKind("v1.4.8", "v1.4.9"), "patch");
  assert.equal(classifyReleaseKind("v1.4.8", "v1.5.0"), "minor");
  assert.equal(classifyReleaseKind("v1.4.8", "v2.0.0"), "major");
  assert.throws(
    () => classifyReleaseKind("v1.4.8", "v1.6.0"),
    /not sequential/,
  );
});

test("publishes only an explicitly selected initial version", () => {
  assert.deepEqual(
    selectReleaseTag({ releasedTags: [], localVersion: "uninitialized" }),
    { tag: null, kind: "none" },
  );
  assert.deepEqual(
    selectReleaseTag({ releasedTags: [], localVersion: "2.3.0" }),
    { tag: "v2.3.0", kind: "initial" },
  );
  assert.deepEqual(
    selectReleaseTag({ releasedTags: ["v2.3.0"], localVersion: "2.3.0" }),
    { tag: null, kind: "none" },
  );
});

test("accepts only the next local major or minor intent", () => {
  assert.deepEqual(
    selectReleaseTag({ releasedTags: ["v1.4.8"], localVersion: "2.0.0" }),
    { tag: "v2.0.0", kind: "major" },
  );
  assert.deepEqual(
    selectReleaseTag({ releasedTags: ["v1.4.8"], localVersion: "1.5.0" }),
    { tag: "v1.5.0", kind: "minor" },
  );
  assert.throws(
    () => selectReleaseTag({ releasedTags: ["v1.4.8"], localVersion: "1.4.9" }),
    /Patch Releases are not created/,
  );
});

test("accepts only canonical release tags", () => {
  assert.equal(isReleaseTag("v2.0.1"), true);
  assert.equal(isReleaseTag("2.0.1"), false);
  assert.equal(isReleaseTag("v2.0.1-beta"), false);
});
