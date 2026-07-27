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
