import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAllowedHosts, writeWorkflowToken } from "../src/config.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function request({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:4240", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, "utf8");
    },
  };
}

function response() {
  return {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-server-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

test("authenticates and creates a local PR without a GitHub head", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  let submitted;
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async submitPullRequest(value) {
        submitted = value;
        return { id: "pr-1", number: 1, checkStatus: "queued" };
      },
    },
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        repository: "LUDIARS/Revisor",
        title: "ローカルワークフローを登録する",
        body: "## 実装内容\n- head branch を登録する。\n\n## 受け入れ条件\n- GitHub head を必要としない。",
        author: "neco",
        head_ref: "feat/local-workflow",
      }),
    }), output);
    assert.equal(output.status, 202);
    assert.equal(submitted.repository, "LUDIARS/Revisor");
    assert.equal(submitted.headRef, "feat/local-workflow");
    assert.equal(submitted.reviewLane, "standard");
    assert.equal("headSha" in submitted, false);
    assert.deepEqual(JSON.parse(output.body).pullRequest, {
      id: "pr-1",
      number: 1,
      checkStatus: "queued",
    });
  } finally {
    removeFixture(state.directory);
  }
});

test("accepts an explicit fast-lane submission and authenticated queued promotion", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const calls = [];
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async submitPullRequest(value) {
        calls.push(["submit", value.reviewLane]);
        return { id: "pr-1", reviewLane: value.reviewLane };
      },
      async promotePullRequest(id, options) {
        calls.push(["promote", id, options.sessionId]);
        return { id, reviewLane: "fast" };
      },
    },
  });
  try {
    const submitted = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        repository: "LUDIARS/Revisor",
        title: "ファストレーンで審査する",
        body: "## 実装内容\n- 明示指定を追加する。\n\n## 受け入れ条件\n- 通常時は使用しない。",
        head_ref: "feat/fast",
        fast_lane: true,
      }),
    }), submitted);
    assert.equal(submitted.status, 202);

    const promoted = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/fast-lane",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({ session_id: "lictor-owner" }),
    }), promoted);
    assert.equal(promoted.status, 200);
    assert.deepEqual(calls, [
      ["submit", "fast"],
      ["promote", "pr-1", "lictor-owner"],
    ]);

    const malformed = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/fast-lane",
      headers: { authorization: "Bearer workflow-token" },
      body: "{",
    }), malformed);
    assert.equal(malformed.status, 400);
    assert.deepEqual(calls, [
      ["submit", "fast"],
      ["promote", "pr-1", "lictor-owner"],
    ]);
  } finally {
    removeFixture(state.directory);
  }
});

test("manual retry uses the fast lane only for a strict fresh opt-in", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const calls = [];
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async retryPullRequest(id, options) {
        calls.push([id, options.fastLane]);
        return { id, reviewLane: options.fastLane ? "fast" : "standard" };
      },
    },
  });
  try {
    const standard = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/retry",
      headers: { authorization: "Bearer workflow-token" },
    }), standard);
    assert.equal(standard.status, 202);

    const fast = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/retry",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({ fast_lane: true }),
    }), fast);
    assert.equal(fast.status, 202);

    const invalid = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/retry",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({ fast_lane: "true" }),
    }), invalid);
    assert.equal(invalid.status, 400);

    const malformedWorkflow = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr-1/retry",
      headers: { authorization: "Bearer workflow-token" },
      body: "{",
    }), malformedWorkflow);
    assert.equal(malformedWorkflow.status, 400);

    const malformedUi = response();
    await handler(request({
      method: "POST",
      url: "/api/local-prs/pr-1/retry",
      headers: { "x-revisor-session": "ui-token" },
      body: "{",
    }), malformedUi);
    assert.equal(malformedUi.status, 400);
    assert.deepEqual(calls, [["pr-1", false], ["pr-1", true]]);
  } finally {
    removeFixture(state.directory);
  }
});

test("rejects incomplete PR content before the review service can enqueue tests", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  let submitted = false;
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async submitPullRequest() {
        submitted = true;
        return { id: "pr-1" };
      },
    },
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        repository: "LUDIARS/Revisor",
        title: "内容不足の PR",
        body: "## 実装内容\n- 受け入れ条件が無い。",
        author: "neco",
        head_ref: "feat/local-workflow",
      }),
    }), output);
    assert.equal(output.status, 400);
    assert.match(JSON.parse(output.body).error, /受け入れ条件/);
    assert.equal(submitted, false);
  } finally {
    removeFixture(state.directory);
  }
});

test("rejects unauthenticated local workflow requests", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    }), output);
    assert.equal(output.status, 401);
  } finally {
    removeFixture(state.directory);
  }
});

test("serves read-only local API requests to loopback without a token", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    reviewWorkers: {
      state: () => ({
        queues: [{
          id: "review",
          label: "モデルレビュー",
          workers: { configured: 1, idle: 0, running: 1 },
          queued: [],
          running: [{ repository: "LUDIARS/Vultus", number: 42, status: "running" }],
        }],
      }),
    },
    localPrService: {
      listPullRequests: () => [{ id: "pr-1", number: 1 }],
      testWorkflowProducts: () => [{ repository: "LUDIARS/Revisor", number: 1 }],
      // 一覧だけでなく詳細・リポジトリ一覧も token 無しで開く。 詳細は本文と
      // leakage/security の指摘位置を、 リポジトリ一覧は作業ツリーの絶対パスを
      // 返すので、 開いている読み取り面をテストで明示しておく。
      getPullRequest: () => ({ id: "pr-1", number: 1, body: "local only" }),
      listRepositories: () => [{ repository: "LUDIARS/Revisor", rootPath: "E:/Document/Ars/Revisor" }],
    },
  });
  try {
    // 本文まで見る。 status だけだと、 認証を通ったが投影が空で返る退行を拾えない。
    const reads = [
      ["/v1/local-prs", (body) => assert.equal(body.pullRequests[0].id, "pr-1")],
      ["/v1/local-prs/pr-1", (body) => assert.equal(body.pullRequest.body, "local only")],
      ["/v1/repositories", (body) => assert.equal(body.repositories[0].rootPath, "E:/Document/Ars/Revisor")],
      ["/v1/test-workflow", (body) => assert.equal(body.products[0].number, 1)],
      ["/v1/review-work", (body) => assert.equal(body.workers.queues[0].running[0].number, 42)],
    ];
    for (const [url, assertBody] of reads) {
      const output = response();
      await handler(request({ method: "GET", url }), output);
      assert.equal(output.status, 200);
      assertBody(JSON.parse(output.body));
    }
  } finally {
    removeFixture(state.directory);
  }
});

test("serves a session-authorized local PR file list and one selected diff", async () => {
  const handler = createRequestHandler({
    env: {},
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
    pullRequestDiffs: {
      files: async (id) => ({
        pullRequestId: id,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        files: [{ status: "modified", path: "src/view.mjs", previousPath: null }],
      }),
      fileDiff: async (id, path) => ({
        pullRequestId: id,
        file: { status: "modified", path, previousPath: null },
        diff: "diff --git a/src/view.mjs b/src/view.mjs",
      }),
    },
  });
  const headers = { "x-revisor-session": "ui-token" };
  const files = response();
  await handler(request({ method: "GET", url: "/api/local-prs/pr-1/files", headers }), files);
  assert.equal(files.status, 200);
  assert.equal(JSON.parse(files.body).files[0].path, "src/view.mjs");

  const diff = response();
  await handler(request({
    method: "GET",
    url: "/api/local-prs/pr-1/diff?path=src%2Fview.mjs",
    headers,
  }), diff);
  assert.equal(diff.status, 200);
  assert.match(JSON.parse(diff.body).diff, /diff --git/);
});

// 読み取りを開けても、 破壊的操作は token を要求し続けることを固定する。
test("still requires the token for every mutating local API request", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      mergePullRequest: async () => ({ id: "pr-1", status: "merged" }),
      retryPullRequest: async () => ({ id: "pr-1" }),
      promotePullRequest: async () => ({ id: "pr-1", reviewLane: "fast" }),
      closePullRequest: () => ({ id: "pr-1", status: "closed" }),
    },
  });
  try {
    for (const url of [
      "/v1/local-prs/pr-1/merge",
      "/v1/local-prs/pr-1/retry",
      "/v1/local-prs/pr-1/fast-lane",
      "/v1/local-prs/pr-1/close",
      "/v1/repositories",
    ]) {
      const output = response();
      await handler(request({ method: "POST", url, body: "{}" }), output);
      assert.equal(output.status, 401);
    }
  } finally {
    removeFixture(state.directory);
  }
});

test("closes a local PR from both APIs only when a reason is present", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const closed = [];
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async closePullRequest(id, options) {
        const reason = typeof options.reason === "string" ? options.reason.trim() : "";
        if (!reason) throw new Error("Closing a local PR requires a reason.");
        closed.push({ id, reason });
        return { id, status: "closed", closeReason: reason };
      },
    },
  });
  try {
    const withReason = response();
    await handler(request({
      method: "POST",
      url: "/v1/local-prs/pr%201/close",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({ reason: "別経路で main へ入った" }),
    }), withReason);
    assert.equal(withReason.status, 200);
    assert.equal(JSON.parse(withReason.body).pullRequest.status, "closed");
    // id は URL エンコードを解いて渡す (merge / retry と同じ扱い)。
    assert.deepEqual(closed[0], { id: "pr 1", reason: "別経路で main へ入った" });

    const uiWithReason = response();
    await handler(request({
      method: "POST",
      url: "/api/local-prs/pr-1/close",
      headers: { "x-revisor-session": "ui-token" },
      body: JSON.stringify({ reason: "案を破棄した" }),
    }), uiWithReason);
    assert.equal(uiWithReason.status, 200);
    assert.equal(JSON.parse(uiWithReason.body).pullRequest.status, "closed");
    assert.deepEqual(closed[1], { id: "pr-1", reason: "案を破棄した" });

    const withoutBody = response();
    await handler(request({
      method: "POST",
      url: "/api/local-prs/pr-2/close",
      headers: { "x-revisor-session": "ui-token" },
    }), withoutBody);
    assert.equal(withoutBody.status, 400);
    assert.match(JSON.parse(withoutBody.body).error, /requires a reason/);
    assert.equal(closed.length, 2);
  } finally {
    removeFixture(state.directory);
  }
});

// DNS rebinding: 接続元は loopback でも Host が別ドメインなら token を要求する。
test("requires the token for reads sent through a non-loopback host", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: { listPullRequests: () => [{ id: "pr-1", number: 1 }] },
  });
  try {
    const rejected = response();
    await handler(request({
      method: "GET",
      url: "/v1/local-prs",
      headers: { host: "rebind.example.com:4240" },
    }), rejected);
    assert.equal(rejected.status, 401);

    const allowed = response();
    await handler(request({
      method: "GET",
      url: "/v1/local-prs",
      headers: { host: "rebind.example.com:4240", authorization: "Bearer workflow-token" },
    }), allowed);
    assert.equal(allowed.status, 200);
  } finally {
    removeFixture(state.directory);
  }
});

// token 未設定のマシンでも読み取りは動く (設定不在で一覧まで止めない)。
test("reads without a configured workflow token", async () => {
  const state = fixture();
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: { listPullRequests: () => [] },
  });
  const output = response();
  try {
    await handler(request({ method: "GET", url: "/v1/local-prs" }), output);
    assert.equal(output.status, 200);
  } finally {
    removeFixture(state.directory);
  }
});

test("filters and summarizes local PR lists without changing the default response", async () => {
  const pullRequests = [{
    id: "pr-open", number: 1, repository: "LUDIARS/Revisor", title: "Open PR",
    status: "open", checkStatus: "queued", reviewLane: "standard",
    headSha: "a".repeat(40), externalVerification: null,
    createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z",
    decision: { state: "needs_human" }, body: "full record",
  }, {
    id: "pr-merged", number: 2, repository: "LUDIARS/Revisor", title: "Merged PR",
    status: "merged", checkStatus: "test_ok", createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:01:00.000Z", decision: { state: "auto_ok" }, body: "merged record",
  }];
  const handler = createRequestHandler({
    env: {}, sessionToken: "ui-token", queue: { state: () => ({}) },
    localPrService: { listPullRequests: () => pullRequests },
  });
  const full = response();
  await handler(request({ method: "GET", url: "/v1/local-prs" }), full);
  assert.equal(full.status, 200);
  assert.equal(full.body, JSON.stringify({ pullRequests }));

  const summary = response();
  await handler(request({ method: "GET", url: "/v1/local-prs?view=summary&state=open" }), summary);
  assert.equal(summary.status, 200);
  assert.deepEqual(JSON.parse(summary.body).pullRequests, [{
    id: "pr-open", number: 1, repository: "LUDIARS/Revisor", title: "Open PR",
    status: "open", checkStatus: "queued", reviewLane: "standard",
    headSha: "a".repeat(40), externalVerification: null,
    createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z",
    decision: { state: "needs_human" },
  }]);

  const invalid = response();
  await handler(request({ method: "GET", url: "/v1/local-prs?view=compact" }), invalid);
  assert.equal(invalid.status, 400);
});

test("serves version state and confirmed release actions through the UI session", async () => {
  const calls = [];
  const handler = createRequestHandler({
    env: {},
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
    releaseService: {
      listProjects: async () => [{
        repository: "LUDIARS/Product",
        version: { status: "ready", version: "1.4.8", managed: true },
      }],
      initialize: async (repository, version) => {
        calls.push(["initialize", repository, version]);
        return { repository, version };
      },
      release: async (repository, release) => {
        calls.push(["release", repository, release]);
        return { repository, tag: "v2.0.0" };
      },
    },
  });
  const headers = { "x-revisor-session": "ui-token" };
  const list = response();
  await handler(request({ method: "GET", url: "/api/releases", headers }), list);
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body).projects[0].version.version, "1.4.8");

  const initialize = response();
  await handler(request({
    method: "POST",
    url: "/api/releases/LUDIARS%2FProduct/initialize",
    headers,
    body: JSON.stringify({ version: "1.4.8", confirm: true }),
  }), initialize);
  assert.equal(initialize.status, 200);

  const publish = response();
  await handler(request({
    method: "POST",
    url: "/api/releases/LUDIARS%2FProduct/publish",
    headers,
    body: JSON.stringify({
      kind: "major",
      expectedVersion: "1.4.8",
      title: "Product 2",
      notes: "Breaking changes.",
      confirm: true,
    }),
  }), publish);
  assert.equal(publish.status, 200);
  assert.deepEqual(calls, [
    ["initialize", "LUDIARS/Product", "1.4.8"],
    ["release", "LUDIARS/Product", {
      kind: "major",
      expectedVersion: "1.4.8",
      title: "Product 2",
      notes: "Breaking changes.",
    }],
  ]);
});

test("rejects non-loopback clients before reading credentials", async () => {
  const handler = createRequestHandler({
    env: {},
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
  });
  const output = response();
  const input = request({ method: "GET", url: "/v1/local-prs" });
  input.socket.remoteAddress = "203.0.113.7";
  await handler(input, output);
  assert.equal(output.status, 403);
});

test("serves the UI through an encrypted configured host", async () => {
  const state = fixture();
  try {
    writeAllowedHosts(["revisor.example.com"], state.env);
    const handler = createRequestHandler({
      env: state.env,
      sessionToken: "ui-token",
      queue: { state: () => ({}) },
      localPrService: {},
    });
    const allowed = response();
    await handler(request({
      method: "GET",
      url: "/",
      headers: { host: "revisor.example.com" },
    }), allowed);
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /<h1>Revisor<\/h1>/);

    const rejected = response();
    await handler(request({
      method: "GET",
      url: "/",
      headers: { host: "other.example.com" },
    }), rejected);
    assert.equal(rejected.status, 403);
    assert.match(JSON.parse(rejected.body).error, /Host is not allowed/);
  } finally {
    removeFixture(state.directory);
  }
});
