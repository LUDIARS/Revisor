import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyReviewCompletion,
  reviewCompletionMessage,
} from "../src/review-completion-notice.mjs";
import { LocalPrReporter } from "../src/local-reporter.mjs";

function pr(overrides = {}) {
  return {
    id: "pr-1",
    repository: "LUDIARS/Concordia",
    number: 3,
    sessionId: "lictor-abc",
    status: "open",
    checkStatus: "test_ok",
    mergeCommitSha: null,
    reasons: [],
    advisories: [],
    humanQuestion: null,
    error: null,
    ...overrides,
  };
}

test("names the verdict for each terminal state", () => {
  const ok = reviewCompletionMessage(pr());
  assert.match(ok, /Test OK/);
  // Test OK の PR は TestWorkflow フォーラムに載るので、そこへ誘導する。
  assert.match(ok, /TestWorkflow/);
  assert.match(
    reviewCompletionMessage(pr({ checkStatus: "action_required", reasons: ["tests failed"] })),
    /マージできません[\s\S]*tests failed/,
  );
  const failed = reviewCompletionMessage(pr({ checkStatus: "failed", error: "worker died" }));
  assert.match(failed, /レビュー失敗/);
  assert.match(failed, /worker died/);
});

test("reports an automatic merge instead of pointing at a forum thread", () => {
  // 通知は自動マージの後。マージ済み PR は TestWorkflow フォーラム
  // (status === "open" のみ) に載らないので、そこへ誘導してはいけない。
  const merged = reviewCompletionMessage(pr({
    status: "merged",
    mergeCommitSha: "0123456789abcdef0123",
  }));
  assert.match(merged, /自動マージ/);
  assert.match(merged, /0123456789ab/);
  assert.doesNotMatch(merged, /TestWorkflow/);
  assert.doesNotMatch(merged, /マージ可能/);
});

test("does not send a draft to a TestWorkflow thread it never gets", () => {
  // TestWorkflow の一覧は draft !== true で絞られるので、draft の Test OK に
  // 「そのスレッドで動作確認を記録して」と言うと存在しない場所を指す。
  const draft = reviewCompletionMessage(pr({ draft: true }));
  assert.match(draft, /Test OK/);
  assert.match(draft, /draft を外して/);
  assert.doesNotMatch(draft, /フォーラムのスレッドで記録/);
});

test("lists advisories and the human question without hiding the verdict", () => {
  const text = reviewCompletionMessage(pr({
    advisories: ["spec_linkage"],
    humanQuestion: "対象ドメインは?",
  }));
  assert.match(text, /Test OK/);
  assert.match(text, /spec_linkage/);
  assert.match(text, /対象ドメインは\?/);
});

test("caps a long reason list instead of flooding the session", () => {
  const reasons = Array.from({ length: 9 }, (_, i) => `reason ${i + 1}`);
  const text = reviewCompletionMessage(pr({ checkStatus: "action_required", reasons }));
  assert.match(text, /reason 5/);
  assert.doesNotMatch(text, /reason 6/);
  assert.match(text, /ほか 4 件/);
});

test("stays silent when the submission carried no session", async () => {
  let called = false;
  const sent = await notifyReviewCompletion({
    pullRequest: pr({ sessionId: null }),
    baseUrl: "http://127.0.0.1:11111",
    notify: async () => { called = true; return true; },
  });
  assert.equal(sent, false);
  assert.equal(called, false);
});

test("stays silent when Concordia cannot be located", async () => {
  let called = false;
  const sent = await notifyReviewCompletion({
    pullRequest: pr(),
    baseUrl: null,
    notify: async () => { called = true; return true; },
  });
  assert.equal(sent, false);
  assert.equal(called, false);
});

function makeStore(record) {
  return {
    updatePullRequest(id, patch) {
      Object.assign(record, patch);
      return record;
    },
    getPullRequest() {
      return record;
    },
  };
}

test("announces both a completed review and a failed one", async () => {
  const record = pr({ checkStatus: "queued" });
  const announced = [];
  const reporter = new LocalPrReporter(makeStore(record), {
    notifyCompletion: (pullRequest) => {
      announced.push(pullRequest.checkStatus);
    },
  });

  await reporter.completed({ request: { localPrId: "pr-1", headSha: "abc" }, result: { conclusion: "success" } });
  await reporter.failed({ request: { localPrId: "pr-1" }, error: "boom" });

  assert.deepEqual(announced, ["test_ok", "failed"]);
});

test("a notification failure never fails the job", async () => {
  const record = pr();
  const reporter = new LocalPrReporter(makeStore(record), {
    notifyCompletion: () => { throw new Error("concordia down"); },
  });
  await reporter.completed({ request: { localPrId: "pr-1", headSha: "abc" }, result: { conclusion: "success" } });
  await reporter.failed({ request: { localPrId: "pr-1" }, error: "boom" });
});

test("announces after the automatic merge so the state is final", async () => {
  const record = pr();
  const order = [];
  const reporter = new LocalPrReporter(makeStore(record), {
    afterCompleted: async () => { order.push("auto-merge"); },
    notifyCompletion: () => { order.push("notify"); },
  });
  await reporter.completed({ request: { localPrId: "pr-1", headSha: "abc" }, result: { conclusion: "success" } });
  assert.deepEqual(order, ["auto-merge", "notify"]);
});
