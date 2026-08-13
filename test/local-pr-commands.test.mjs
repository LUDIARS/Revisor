import assert from "node:assert/strict";
import test from "node:test";
import { runLocalPrCommand } from "../src/local-pr-commands.mjs";

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
