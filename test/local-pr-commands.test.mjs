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
