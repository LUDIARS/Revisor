import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("numbers pull requests from one global sequence across repositories", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-"));
  const path = join(directory, "state.json");
  let id = 0;
  const store = new LocalPrStore({
    path,
    createId: () => `id-${++id}`,
    now: () => "2026-08-03T00:00:00.000Z",
  });
  try {
    for (const repository of ["LUDIARS/Revisor", "LUDIARS/Concordia"]) {
      store.registerRepository({
        repository,
        rootPath: `E:/Document/Ars/${repository.split("/")[1]}`,
        baseRef: "main",
        testCases: [],
      });
    }
    const first = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "one", body: "", author: "neco",
      headRef: "feat/a", baseRef: "main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40),
    });
    const second = store.createPullRequest({
      repository: "LUDIARS/Concordia",
      title: "two", body: "", author: "neco",
      headRef: "feat/b", baseRef: "main",
      headSha: "c".repeat(40), baseSha: "d".repeat(40),
    });
    const third = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "three", body: "", author: "neco",
      headRef: "feat/c", baseRef: "main",
      headSha: "e".repeat(40), baseSha: "f".repeat(40),
    });
    // 別リポでも番号は共有 — Rv#n だけで PR が一意に特定できる。
    assert.deepEqual([first.number, second.number, third.number], [1, 2, 3]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a v1 per-repository numbered state to the global sequence", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-"));
  const path = join(directory, "state.json");
  try {
    const v1PullRequest = (number, repository, createdAt) => ({
      id: `${repository}-${number}`,
      number,
      repository,
      title: "t", body: "", author: "neco",
      draft: false, labels: [], assignees: [], reviewers: [],
      headRef: `feat/${number}`, baseRef: "main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40),
      status: "open", checkStatus: "queued", mergeCommitSha: null,
      createdAt, updatedAt: createdAt,
    });
    writeFileSync(path, JSON.stringify({
      version: 1,
      repositories: [],
      pullRequests: [
        v1PullRequest(1, "LUDIARS/Revisor", "2026-08-01T00:00:00.000Z"),
        v1PullRequest(1, "LUDIARS/Concordia", "2026-08-01T01:00:00.000Z"),
        v1PullRequest(2, "LUDIARS/Revisor", "2026-08-01T02:00:00.000Z"),
      ],
    }), "utf8");
    const store = new LocalPrStore({ path, now: () => "2026-08-03T00:00:00.000Z" });
    const numbered = Object.fromEntries(
      store.listPullRequests().map((pullRequest) => [pullRequest.id, pullRequest.number]),
    );
    // createdAt 昇順で 1 から振り直す。
    assert.deepEqual(numbered, {
      "LUDIARS/Revisor-1": 1,
      "LUDIARS/Concordia-1": 2,
      "LUDIARS/Revisor-2": 3,
    });
    // 次の採番は移行後の連番から続く。
    const next = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "four", body: "", author: "neco",
      headRef: "feat/next", baseRef: "main",
      headSha: "c".repeat(40), baseSha: "d".repeat(40),
    });
    assert.equal(next.number, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
