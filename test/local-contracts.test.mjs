import assert from "node:assert/strict";
import test from "node:test";
import {
  validateFastLanePromotion,
  validatePullRequestSubmission,
  validateRepositoryRegistration,
  validateReviewRetry,
} from "../src/local-contracts.mjs";

const PR_CONTENT = [
  "## 実装内容",
  "- ローカル PR の内容契約を検証する。",
  "",
  "## 受け入れ条件",
  "- 不十分な内容ではテストを開始しない。",
].join("\n");

function pullRequestInput(overrides = {}) {
  return {
    repository: "LUDIARS/Revisor",
    title: "ローカル PR の内容契約を追加する",
    body: PR_CONTENT,
    head_ref: "feat/local-pr",
    ...overrides,
  };
}

test("requires test cases at repository registration", () => {
  assert.throws(() => validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor",
    base_ref: "main",
    test_cases: [],
  }), /At least one test case/);
});

test("rejects repository paths containing Git-config control characters", () => {
  assert.throws(() => validateRepositoryRegistration({
    repository: "LUDIARS/Revisor",
    root_path: "E:/Document/Ars/Revisor\n[include]",
    test_cases: [{ name: "unit", command: "npm", args: ["test"] }],
  }), /root_path must not contain control characters/);
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
  assert.deepEqual(validatePullRequestSubmission(pullRequestInput({
    draft: true,
  })), {
    repository: "LUDIARS/Revisor",
    title: "ローカル PR の内容契約を追加する",
    body: PR_CONTENT,
    sourceLinks: [],
    author: "local",
    draft: false,
    labels: [],
    assignees: [],
    reviewers: [],
    headRef: "feat/local-pr",
    baseRef: undefined,
    reviewLane: "standard",
    // 投稿元セッション未指定 = 完了通知の宛先なし (CLI / スクリプト投稿)。
    sessionId: null,
  });
});

test("uses the fast lane only after an explicit boolean opt-in", () => {
  assert.equal(validatePullRequestSubmission(pullRequestInput()).reviewLane, "standard");
  assert.equal(validatePullRequestSubmission(pullRequestInput({ fast_lane: false })).reviewLane, "standard");
  assert.equal(validatePullRequestSubmission(pullRequestInput({ fast_lane: true })).reviewLane, "fast");
  assert.throws(
    () => validatePullRequestSubmission(pullRequestInput({ fast_lane: "true" })),
    /fast_lane must be a boolean/,
  );
});

test("validates optional retry and promotion bodies at the local API boundary", () => {
  assert.deepEqual(validateReviewRetry(null), { fastLane: false });
  assert.deepEqual(validateReviewRetry({ fast_lane: true }), { fastLane: true });
  // Force-abandonment is intentionally CLI-only; an authenticated HTTP caller
  // still receives the ordinary retry contract even if it supplies this field.
  assert.deepEqual(validateReviewRetry({ force: true }), { fastLane: false });
  assert.throws(() => validateReviewRetry([]), /Request body must be an object/);
  assert.throws(() => validateReviewRetry({ fast_lane: "true" }), /must be a boolean/);

  assert.deepEqual(validateFastLanePromotion(null), { sessionId: null });
  assert.deepEqual(
    validateFastLanePromotion({ session_id: "lictor-owner" }),
    { sessionId: "lictor-owner" },
  );
  assert.throws(
    () => validateFastLanePromotion({ session_id: "x".repeat(129) }),
    /session_id is invalid/,
  );
});

test("validates Discord and Slack source links", () => {
  const submission = validatePullRequestSubmission(pullRequestInput({
    source_links: [
      {
        platform: "discord",
        label: "Discord セッション投稿",
        url: "https://discord.com/channels/1/2/3",
      },
      {
        platform: "slack",
        label: "Slack セッション投稿",
        url: "https://workspace.slack.com/archives/C1/p123",
      },
    ],
  }));
  assert.equal(submission.sourceLinks.length, 2);
  assert.throws(() => validatePullRequestSubmission(pullRequestInput({
    source_links: [{ platform: "discord", label: "wrong", url: "https://example.com/1" }],
  })), /does not identify a source message/);
  assert.throws(() => validatePullRequestSubmission(pullRequestInput({
    source_links: [{
      platform: "discord",
      label: "credential-bearing link",
      url: "https://token@discord.com/channels/1/2/3",
    }],
  })), /must not contain credentials/);
  assert.throws(() => validatePullRequestSubmission(pullRequestInput({
    source_links: [{
      platform: "slack",
      label: "token in query",
      url: "https://workspace.slack.com/archives/C1/p123?access_token=value",
    }],
  })), /must not contain credentials/);
  assert.throws(() => validatePullRequestSubmission(pullRequestInput({
    source_links: [{
      platform: "slack",
      label: "redirect endpoint",
      url: "https://workspace.slack.com/redirect?url=https://example.com",
    }],
  })), /does not identify a source message/);
});

test("keeps the submitting session so the review verdict can reach it", () => {
  const submission = validatePullRequestSubmission(pullRequestInput({
    session_id: "lictor-abc",
  }));
  assert.equal(submission.sessionId, "lictor-abc");
  // 宛先は任意項目なので、空欄で埋めてくるクライアントの投稿ごと落とさない。
  assert.equal(validatePullRequestSubmission(pullRequestInput({
    session_id: "  ",
  })).sessionId, null);
  assert.throws(() => validatePullRequestSubmission(pullRequestInput({
    session_id: "x".repeat(129),
  })));
});

test("rejects non-Japanese or incomplete PR content before it reaches review", () => {
  assert.throws(
    () => validatePullRequestSubmission(pullRequestInput({ title: "Add PR contract" })),
    /PR title must be written in Japanese/,
  );
  assert.throws(
    () => validatePullRequestSubmission(pullRequestInput({ body: "## 実装内容\n- 内容" })),
    /requires a non-empty '## 受け入れ条件' section/,
  );
  assert.throws(
    () => validatePullRequestSubmission(pullRequestInput({
      body: "## 実装内容\n- implement contract\n\n## 受け入れ条件\n- satisfy requirements",
    })),
    /must be written in Japanese/,
  );
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
