import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalPrStore } from "../src/state-store.mjs";

test("persists local PR status and projects only Open / Test OK products", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-"));
  const path = join(directory, "state.json");
  let id = 0;
  const store = new LocalPrStore({
    path,
    createId: () => `id-${++id}`,
    now: () => "2026-07-28T00:00:00.000Z",
  });
  try {
    store.registerRepository({
      repository: "LUDIARS/Revisor",
      rootPath: "E:/Document/Ars/Revisor",
      baseRef: "main",
      testCases: [{ name: "unit" }],
    });
    const pullRequest = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "Local PR",
      body: "",
      author: "neco",
      headRef: "feat/local",
      baseRef: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    });
    assert.deepEqual(store.testWorkflowProducts(), []);
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: "a".repeat(40),
    });
    assert.deepEqual(store.testWorkflowProducts(), [{
      repository: "LUDIARS/Revisor",
      pullRequestId: pullRequest.id,
      number: 1,
      title: "Local PR",
      status: "Open / Test OK",
      reviewedHeadSha: "a".repeat(40),
      updatedAt: "2026-07-28T00:00:00.000Z",
    }]);
    const reloaded = new LocalPrStore({ path });
    assert.equal(reloaded.getPullRequest(pullRequest.id).checkStatus, "test_ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
