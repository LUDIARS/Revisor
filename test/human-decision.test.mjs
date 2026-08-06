import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedPullRequestForManualMerge,
  canBypassPreMergeSystemFailure,
  isHumanOverrideableReviewHold,
} from "../src/human-decision.mjs";

function pullRequest(overrides = {}) {
  return {
    status: "open",
    checkStatus: "failed",
    draft: false,
    headSha: "a".repeat(40),
    reviewedHeadSha: null,
    reasons: [],
    error: "review worker could not start",
    ...overrides,
  };
}

test("manual approval pins the current head after a system review failure", () => {
  const source = pullRequest();
  assert.equal(isHumanOverrideableReviewHold(source), true);
  assert.deepEqual(approvedPullRequestForManualMerge(source), {
    ...source,
    checkStatus: "test_ok",
    reasons: [],
    error: null,
    humanQuestion: null,
    reviewedHeadSha: source.headSha,
  });
});

test("legacy draft metadata does not block a human override", () => {
  assert.equal(isHumanOverrideableReviewHold(pullRequest({ draft: true })), true);
});

test("an internal TypeError is classified as an overrideable system failure", () => {
  assert.equal(isHumanOverrideableReviewHold(pullRequest({
    error: "execute is not a function",
  })), true);
});

test("pre-merge environment failure becomes bypassable only after it is recorded", () => {
  assert.equal(canBypassPreMergeSystemFailure(pullRequest({
    checkStatus: "test_ok",
    error: null,
    mergeError: "Merge blocked: the pre-merge security scan did not complete (tool missing).",
  })), true);
  assert.equal(canBypassPreMergeSystemFailure(pullRequest({
    checkStatus: "test_ok",
    error: null,
    mergeError: "Merge blocked: 1 security finding(s) at or above 'high'.",
  })), false);
});

test("does not relabel concrete review evidence as a system failure", () => {
  assert.equal(isHumanOverrideableReviewHold(pullRequest({
    error: "Autofix introduced potential information leakage",
  })), false);
  assert.equal(isHumanOverrideableReviewHold(pullRequest({
    checkStatus: "action_required",
    error: null,
    reasons: ["1 registered test case(s) failed"],
  })), false);
  for (const reason of [
    "target domain is still missing",
    "Anatomia gate(s) did not pass: rule_conformance",
    "1 changed architecture rule violation(s) remain",
    "complexity score dropped by 12 points",
  ]) {
    assert.equal(isHumanOverrideableReviewHold(pullRequest({
      checkStatus: "action_required",
      error: null,
      reasons: [reason],
    })), false, reason);
  }
});
