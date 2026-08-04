import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReleaseKind,
  isReleaseTag,
  nextPatchReleaseTag,
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

test("requires an explicit initial version and increments patch after it", () => {
  assert.throws(() => nextPatchReleaseTag([]), /initial release version/);
  assert.throws(
    () => selectReleaseTag({ releasedTags: [], localVersion: "uninitialized" }),
    /Initial version is not set/,
  );
  assert.equal(nextPatchReleaseTag(["v0.1.9", "v1.2.3", "not-a-version"]), "v1.2.4");
  assert.throws(
    () => nextPatchReleaseTag([`v1.0.${Number.MAX_SAFE_INTEGER}`]),
    /cannot advance/,
  );
  assert.deepEqual(
    selectReleaseTag({ releasedTags: [], localVersion: "2.3.0" }),
    { tag: "v2.3.0", kind: "initial" },
  );
  assert.deepEqual(
    selectReleaseTag({ releasedTags: ["v2.3.0"], localVersion: "2.3.0" }),
    { tag: "v2.3.1", kind: "patch" },
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
    /next major\/minor/,
  );
});

test("accepts only canonical release tags", () => {
  assert.equal(isReleaseTag("v2.0.1"), true);
  assert.equal(isReleaseTag("2.0.1"), false);
  assert.equal(isReleaseTag("v2.0.1-beta"), false);
});
