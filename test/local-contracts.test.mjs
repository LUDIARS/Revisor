import assert from "node:assert/strict";
import test from "node:test";
import {
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "../src/local-contracts.mjs";

test("requires test cases at repository registration", () => {
  assert.throws(() => validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    base_ref: "main",
    test_cases: [],
  }), /At least one test case/);
});

test("normalizes argv test cases and local PR metadata", () => {
  const registration = validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    test_cases: [{
      name: "unit",
      command: "npm",
      args: ["test"],
      timeout_ms: 30_000,
    }],
  });
  assert.deepEqual(registration.testCases[0], {
    name: "unit",
    command: "npm",
    args: ["test"],
    cwd: ".",
    timeoutMs: 30_000,
    // Coverage metadata is optional; omitting it keeps the case on executable
    // change only, which is what every pre-existing registration meant.
    kinds: null,
    runtime: false,
    always: false,
  });
  assert.deepEqual(validatePullRequestSubmission({
    repository: "LUDIARS/Revisor",
    title: "Local PR",
    head_ref: "feat/local-pr",
  }), {
    repository: "LUDIARS/Revisor",
    title: "Local PR",
    body: "",
    author: "local",
    draft: false,
    labels: [],
    assignees: [],
    reviewers: [],
    headRef: "feat/local-pr",
    baseRef: undefined,
  });
});

test("rejects shell metacharacters in registered test argv", () => {
  assert.throws(() => validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    test_cases: [{
      name: "unsafe",
      command: "npm",
      args: ["test", "&", "curl", "example.invalid"],
    }],
  }), /args is invalid/);
});

test("accepts and validates review-plan coverage metadata on a test case", () => {
  const registration = validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    test_cases: [{
      name: "smoke",
      command: "npm",
      args: ["run", "smoke"],
      kinds: ["code", "infra", "code"],
      runtime: true,
    }],
  });
  assert.deepEqual(registration.testCases[0].kinds, ["code", "infra"]);
  assert.equal(registration.testCases[0].runtime, true);
  assert.equal(registration.testCases[0].always, false);
});

test("re-accepts the normalized registration it produced", () => {
  const first = validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    test_cases: [{ name: "unit", command: "npm", args: ["test"] }],
  });
  // The validator emits `kinds: null` for an undeclared case, so re-registering
  // from a stored record must not be read as an invalid kind list.
  const again = validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    test_cases: [{ ...first.testCases[0], timeout_ms: first.testCases[0].timeoutMs }],
  });
  assert.deepEqual(again.testCases[0], first.testCases[0]);
});

test("rejects an unknown change kind and a non-boolean flag", () => {
  const base = {
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
  };
  assert.throws(() => validateRepositoryRegistration({
    ...base,
    test_cases: [{ name: "unit", command: "npm", kinds: ["nonsense"] }],
  }), /kinds must be a non-empty subset/);
  assert.throws(() => validateRepositoryRegistration({
    ...base,
    test_cases: [{ name: "unit", command: "npm", kinds: [] }],
  }), /kinds must be a non-empty subset/);
  assert.throws(() => validateRepositoryRegistration({
    ...base,
    test_cases: [{ name: "unit", command: "npm", runtime: "yes" }],
  }), /runtime must be a boolean/);
});
