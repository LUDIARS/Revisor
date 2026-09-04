import assert from "node:assert/strict";
import test from "node:test";
import { runLocalPrCommand } from "../src/local-pr-commands.mjs";

test("repo divergence hides healthy rows but keeps failures that need attention", async () => {
  const writes = [];
  const repositories = [
    { repository: "LUDIARS/Behind", rootPath: "/behind", baseRef: "main" },
    { repository: "LUDIARS/Ahead", rootPath: "/ahead", baseRef: "develop" },
    { repository: "LUDIARS/Broken", rootPath: "/broken", baseRef: "main" },
  ];
  const byRoot = {
    "/behind": { state: "behind", ahead: 0, behind: 2, changedFiles: 1, detail: "behind" },
    "/ahead": { state: "ahead", ahead: 1, behind: 0, changedFiles: 1, detail: "ahead" },
    "/broken": { state: "unknown", ahead: 0, behind: 0, changedFiles: null, detail: "unknown" },
  };
  const inspected = [];

  const code = await runLocalPrCommand(["repo", "divergence", "--json"], {
    stdout: { write(value) { writes.push(value); } },
    createContext: () => ({
      store: { listRepositories: () => repositories },
      jobs: {},
      localPrService: {},
    }),
    async inspectDivergence(input) {
      inspected.push(input);
      return byRoot[input.rootPath];
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(inspected, [
    { rootPath: "/behind", baseRef: "main" },
    { rootPath: "/ahead", baseRef: "develop" },
    { rootPath: "/broken", baseRef: "main" },
  ]);
  assert.deepEqual(JSON.parse(writes.join("")).map((row) => row.repository), [
    "LUDIARS/Behind",
    "LUDIARS/Broken",
  ]);
});

test("repo divergence applies repository filtering before inspection and --all keeps healthy rows", async () => {
  const writes = [];
  const inspected = [];
  const code = await runLocalPrCommand(
    ["repo", "divergence", "--repository", "LUDIARS/Ahead", "--all", "--json"],
    {
      stdout: { write(value) { writes.push(value); } },
      createContext: () => ({
        store: {
          listRepositories: () => [
            { repository: "LUDIARS/Behind", rootPath: "/behind", baseRef: "main" },
            { repository: "LUDIARS/Ahead", rootPath: "/ahead", baseRef: "develop" },
          ],
        },
        jobs: {},
        localPrService: {},
      }),
      async inspectDivergence(input) {
        inspected.push(input);
        return { state: "ahead", ahead: 1, behind: 0, changedFiles: 1, detail: "ahead" };
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(inspected, [{ rootPath: "/ahead", baseRef: "develop" }]);
  assert.deepEqual(JSON.parse(writes.join("")).map((row) => row.repository), ["LUDIARS/Ahead"]);
});

test("lists only recorded checkout sync failures and supports repository filtering", async () => {
  const writes = [];
  const pullRequests = [
    {
      id: "pr-1", number: 1, repository: "LUDIARS/Revisor", status: "merged",
      checkStatus: "test_ok", title: "missing checkout update",
      checkoutSync: { state: "worktree_dirty", detail: "tracked changes remain" },
    },
    {
      id: "pr-2", number: 2, repository: "LUDIARS/Other", status: "merged",
      checkStatus: "test_ok", title: "other repository",
      checkoutSync: { state: "not_fast_forward", detail: "diverged" },
    },
    {
      id: "pr-3", number: 3, repository: "LUDIARS/Revisor", status: "merged",
      checkStatus: "test_ok", title: "legacy success record",
      checkoutSync: { state: "in_sync", detail: "" },
    },
  ];

  const code = await runLocalPrCommand(
    ["pr", "unsynced", "--repository", "LUDIARS/Revisor"],
    {
      stdout: { write(value) { writes.push(value); } },
      createContext: () => ({
        store: { listPullRequests: () => pullRequests },
        jobs: {},
        localPrService: {},
      }),
    },
  );

  assert.equal(code, 0);
  assert.match(writes.join(""), /#1/);
  assert.doesNotMatch(writes.join(""), /#2|#3/);
});

test("a following flag cannot satisfy the required bypass reason", async () => {
  let mergeCalled = false;
  const pullRequest = {
    id: "pr-1",
    number: 1,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "queued",
    title: "recover",
  };
  await assert.rejects(
    runLocalPrCommand(
      ["pr", "merge", "1", "--bypass", "--reason", "--json"],
      {
        stdout: { write() {} },
        createContext: () => ({
          store: { listPullRequests: () => [pullRequest] },
          jobs: {},
          localPrService: {
            async mergePullRequest() {
              mergeCalled = true;
              return pullRequest;
            },
          },
        }),
      },
    ),
    /requires --reason/,
  );
  assert.equal(mergeCalled, false);
});

test("closing from the CLI requires a non-empty reason", async () => {
  let closeCalled = false;
  const pullRequest = {
    id: "pr-1",
    number: 1,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "test_ok",
    title: "withdraw",
  };
  await assert.rejects(
    runLocalPrCommand(
      ["pr", "close", "1", "--reason", "--json"],
      {
        stdout: { write() {} },
        createContext: () => ({
          store: { listPullRequests: () => [pullRequest] },
          jobs: {},
          localPrService: {
            async closePullRequest() {
              closeCalled = true;
              return pullRequest;
            },
          },
        }),
      },
    ),
    /close requires --reason/,
  );
  assert.equal(closeCalled, false);
});

test("forwards --force only through the CLI retry command", async () => {
  const pullRequest = {
    id: "pr-1",
    number: 1,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "running",
    title: "recover stalled review",
  };
  let request;
  const code = await runLocalPrCommand(
    ["pr", "retry", "1", "--force", "--json"],
    {
      stdout: { write() {} },
      createContext: () => ({
        store: { listPullRequests: () => [pullRequest] },
        jobs: {},
        localPrService: {
          async retryPullRequest(id, options) {
            request = { id, ...options };
            return { ...pullRequest, checkStatus: "queued" };
          },
        },
      }),
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(request, { id: "pr-1", fastLane: false, force: true });
});

test("forwards --defer-push only through the CLI merge command", async () => {
  const pullRequest = {
    id: "pr-8",
    number: 8,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "test_ok",
    title: "deferred publish",
  };
  let request;
  const code = await runLocalPrCommand(
    ["pr", "merge", "8", "--defer-push", "--json"],
    {
      stdout: { write() {} },
      createContext: () => ({
        store: { listPullRequests: () => [pullRequest] },
        jobs: {},
        localPrService: {
          async mergePullRequest(id, options) {
            request = { id, ...options };
            return {
              ...pullRequest,
              publication: "deferred",
              mergeCommitSha: "a".repeat(40),
            };
          },
        },
      }),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(request, { id: "pr-8", deferPush: true });
});

test("promotes a queued PR through the explicit fast-lane command", async () => {
  const writes = [];
  const pullRequest = {
    id: "pr-7",
    number: 7,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "queued",
    title: "ファストレーン対応",
  };
  let request;
  const code = await runLocalPrCommand(
    ["pr", "fast-lane", "7", "--session-id", "lictor-owner", "--json"],
    {
      stdout: { write(value) { writes.push(value); } },
      createContext: () => ({
        store: { listPullRequests: () => [pullRequest] },
        jobs: {},
        localPrService: {
          async promotePullRequest(id, options) {
            request = { id, ...options };
            return { ...pullRequest, reviewLane: "fast" };
          },
        },
      }),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(request, { id: "pr-7", sessionId: "lictor-owner" });
  assert.equal(JSON.parse(writes.join("")).reviewLane, "fast");
});

test("rejects an oversized promotion session before calling the service", async () => {
  let promoted = false;
  await assert.rejects(
    () => runLocalPrCommand(
      ["pr", "fast-lane", "7", "--session-id", "x".repeat(129)],
      {
        createContext: () => ({
          store: { listPullRequests: () => [{ id: "pr-7", number: 7 }] },
          jobs: {},
          localPrService: {
            async promotePullRequest() { promoted = true; },
          },
        }),
      },
    ),
    /session_id is invalid/,
  );
  assert.equal(promoted, false);
});
