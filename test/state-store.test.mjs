import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalPrStore } from "../src/state-store.mjs";

test("projects an open PR for early QA while review is queued", () => {
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
    assert.deepEqual(store.testWorkflowProducts(), [{
      repository: "LUDIARS/Revisor",
      pullRequestId: pullRequest.id,
      number: 1,
      title: "Local PR",
      status: "Open / In Review",
      checkStatus: "queued",
      qaMode: "early",
      headSha: "a".repeat(40),
      reviewedHeadSha: null,
      updatedAt: "2026-07-28T00:00:00.000Z",
    }]);
    store.updatePullRequest(pullRequest.id, { checkStatus: "running" });
    assert.equal(store.testWorkflowProducts()[0].status, "Open / In Review");
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
      checkStatus: "test_ok",
      qaMode: "approved",
      headSha: "a".repeat(40),
      reviewedHeadSha: "a".repeat(40),
      updatedAt: "2026-07-28T00:00:00.000Z",
    }]);
    const reloaded = new LocalPrStore({ path });
    assert.equal(reloaded.getPullRequest(pullRequest.id).checkStatus, "test_ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the newest 50 lifecycle events on each pull request", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-events-"));
  const path = join(directory, "state.json");
  let tick = 0;
  const store = new LocalPrStore({
    path,
    createId: () => "pr-events",
    now: () => `2026-08-08T11:${String(tick++).padStart(2, "0")}:00.000Z`,
  });
  try {
    const pullRequest = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "Event history",
      headRef: "feat/events",
      baseRef: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    });
    for (let index = 0; index < 55; index += 1) {
      store.appendPullRequestEvent(pullRequest.id, {
        event: index === 54 ? "review_passed" : "review_queued",
        message: `event ${index}`,
        tone: index === 54 ? "ok" : "warn",
      });
    }
    const events = store.getPullRequest(pullRequest.id).lifecycleEvents;
    assert.equal(events.length, 50);
    assert.equal(events[0].message, "event 5");
    assert.equal(events[49].event, "review_passed");
    assert.equal(events[49].tone, "ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("early QA ignores legacy draft metadata but excludes settled reviews that need action", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-"));
  const path = join(directory, "state.json");
  let id = 0;
  const store = new LocalPrStore({
    path,
    createId: () => `id-${++id}`,
    now: () => "2026-08-04T00:00:00.000Z",
  });
  try {
    store.registerRepository({
      repository: "LUDIARS/Revisor",
      rootPath: "E:/Document/Ars/Revisor",
      baseRef: "main",
      testCases: [],
    });
    const draft = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "Draft",
      draft: true,
      headSha: "a".repeat(40),
    });
    assert.equal(store.testWorkflowProducts()[0].pullRequestId, draft.id);
    store.updatePullRequest(draft.id, { checkStatus: "action_required" });
    assert.deepEqual(store.testWorkflowProducts(), []);
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

test("emits identifier-only events after persisted PR changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-"));
  const path = join(directory, "state.json");
  const events = [];
  const store = new LocalPrStore({
    path,
    createId: () => "pr-event",
    now: () => "2026-08-05T00:00:00.000Z",
    onEvent: (event) => events.push(event),
  });
  try {
    const pullRequest = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "realtime status", body: "must not enter the event", author: "neco",
      headRef: "feat/realtime", baseRef: "main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40),
    });
    store.updatePullRequest(pullRequest.id, { checkStatus: "running", error: "private output" });
    assert.deepEqual(events.map((event) => event.type), [
      "pull_request.created",
      "pull_request.updated",
    ]);
    assert.deepEqual(events.at(-1), {
      type: "pull_request.updated",
      pullRequestId: "pr-event",
      repository: "LUDIARS/Revisor",
      number: 1,
      status: "open",
      checkStatus: "running",
      updatedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal("body" in events.at(-1), false);
    assert.equal("error" in events.at(-1), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
