import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMeaningfulReviewDiff,
  codeChangedLines,
  editedDomainCount,
  selectReviewStrategy,
} from "../src/review-strategy.mjs";

const codeClassification = { counts: { code: 1 }, codeDomainRequired: true };

test("counts code body lines without headers or documentation", () => {
  const diff = [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "--- a/src/a.mjs", "+++ b/src/a.mjs", "@@ -1 +1 @@", "-old", "+new",
    "diff --git a/README.md b/README.md",
    "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new",
  ].join("\n");
  assert.equal(codeChangedLines(diff), 2);
});

test("counts code in Git-quoted paths", () => {
  const diff = [
    'diff --git "a/src/a file.mjs" "b/src/a file.mjs"',
    '--- "a/src/a file.mjs"',
    '+++ "b/src/a file.mjs"',
    "@@ -1 +1 @@", "-old", "+new",
  ].join("\n");
  assert.equal(codeChangedLines(diff), 2);
});

test("selects two agents for a large code diff", () => {
  const diff = `diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n${"+x\n".repeat(4)}`;
  const strategy = selectReviewStrategy({
    classification: codeClassification,
    unifiedDiff: diff,
    analysis: { domain: { targetDomains: [] } },
    settings: { largeReviewLineThreshold: 3, multiDomainReviewThreshold: 3 },
  });
  assert.equal(strategy.mode, "multi-agent");
  assert.deepEqual(strategy.investigator, { effort: "medium" });
  assert.deepEqual(strategy.judge, { effort: "high" });
});

test("selects high effort for Y edited Anatomia domains", () => {
  const analysis = { domain: { targetDomains: [
    { name: "one", changedAnchors: ["a"] },
    { name: "two", changedAnchors: ["b"] },
    { name: "ignored", changedAnchors: [] },
  ] } };
  assert.equal(editedDomainCount(analysis), 2);
  const strategy = selectReviewStrategy({
    classification: codeClassification,
    unifiedDiff: "diff --git a/src/a.mjs b/src/a.mjs\n+x",
    analysis,
    settings: { largeReviewLineThreshold: 1_000, multiDomainReviewThreshold: 2 },
  });
  assert.equal(strategy.reason, "multi-domain");
  assert.deepEqual(strategy.judge, { effort: "high" });
});

test("keeps non-code changes on one medium-effort agent and rejects empty review diffs", () => {
  const strategy = selectReviewStrategy({
    classification: { counts: { docs: 1 }, codeDomainRequired: false },
    unifiedDiff: "diff --git a/README.md b/README.md\n+x",
    analysis: { domain: { targetDomains: [] } },
    settings: {},
  });
  assert.equal(strategy.reason, "non-code");
  assert.deepEqual(strategy.judge, { effort: "medium" });
  assert.throws(() => assertMeaningfulReviewDiff({ changedPaths: [], unifiedDiff: "" }), /base branch/);
});
