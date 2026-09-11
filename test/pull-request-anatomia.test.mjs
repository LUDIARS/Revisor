import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openRevisorDatabase } from "../src/revisor-db.mjs";
import { LocalPrStore } from "../src/state-store.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const ANALYSIS = Object.freeze({
  domain: { hasTargetDomain: true },
  quality: {
    complexity: { functions: 2, score: 80 },
    functionComplexity: {
      version: 1,
      metric: "call-out-degree-plus-one",
      functions: [{ key: "a", structuralHash: null, value: 1 }, { key: "b", structuralHash: null, value: 2 }],
    },
  },
  architecture: {},
  baselineFunctionComplexity: { version: 1, functions: [] },
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-anatomia-"));
  return { directory, path: join(directory, "revisor.db") };
}

function createStore(path) {
  let id = 0;
  return new LocalPrStore({
    path,
    createId: () => `id-${++id}`,
    now: () => "2026-09-11T00:00:00.000Z",
  });
}

function submit(store) {
  return store.createPullRequestIfAbsent({
    repository: "LUDIARS/Revisor",
    title: "Local PR",
    body: "",
    author: "neco",
    headRef: "feat/local",
    baseRef: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
  }).pullRequest;
}

/** 別コネクションで生の行を読む (store の射影を通さない)。 */
function rawRows(path, id) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const main = database.prepare("SELECT record FROM pull_requests WHERE id = ?").get(id);
    const side = database.prepare("SELECT record FROM pull_request_anatomia WHERE id = ?").get(id);
    const split = database.prepare("SELECT value FROM meta WHERE key = 'anatomia_split'").get();
    return {
      main: JSON.parse(main.record),
      side: side ? JSON.parse(side.record) : undefined,
      split: split?.value ?? null,
    };
  } finally {
    database.close();
  }
}

test("list records leave the analysis out and single reads restore it", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    assert.equal("anatomia" in store.getPullRequest(pullRequest.id), false);

    store.updatePullRequest(pullRequest.id, { anatomia: ANALYSIS, checkStatus: "running" });

    const [listed] = store.listPullRequests();
    assert.equal("anatomia" in listed, false);
    assert.equal(listed.checkStatus, "running");
    assert.deepEqual(store.getPullRequest(pullRequest.id).anatomia, ANALYSIS);
    assert.deepEqual(store.getPullRequestAnatomia(pullRequest.id), ANALYSIS);
    const raw = rawRows(path, pullRequest.id);
    assert.equal("anatomia" in raw.main, false);
    assert.deepEqual(raw.side, ANALYSIS);
    assert.equal(raw.split, "1");
  } finally {
    removeFixture(directory);
  }
});

test("status updates and events keep the stored analysis; a reset is kept as null", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { anatomia: ANALYSIS });
    store.updatePullRequest(pullRequest.id, { checkStatus: "test_ok" });
    store.appendPullRequestEvent(pullRequest.id, { event: "review", message: "done" });
    assert.deepEqual(store.getPullRequest(pullRequest.id).anatomia, ANALYSIS);

    // patch 関数には解析結果を含む全体が渡る (再投入が引き継ぐ段階の成果を読む)。
    let seen;
    store.updatePullRequestWith(pullRequest.id, (current) => {
      seen = current.anatomia;
      return { title: "renamed" };
    });
    assert.deepEqual(seen, ANALYSIS);
    assert.deepEqual(store.getPullRequest(pullRequest.id).anatomia, ANALYSIS);

    store.updatePullRequest(pullRequest.id, { anatomia: null });
    assert.equal(store.getPullRequest(pullRequest.id).anatomia, null);
    assert.equal(store.getPullRequestAnatomia(pullRequest.id), null);
  } finally {
    removeFixture(directory);
  }
});

test("re-submitting the same head returns the record with its analysis", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { anatomia: ANALYSIS });

    const reused = submit(store);
    assert.equal(reused.id, pullRequest.id);
    assert.deepEqual(reused.anatomia, ANALYSIS);
    assert.deepEqual(
      store.findExactPullRequest("LUDIARS/Revisor", "a".repeat(40)).anatomia,
      ANALYSIS,
    );
  } finally {
    removeFixture(directory);
  }
});

test("opening an older database moves inline analyses out once", () => {
  const { directory, path } = fixture();
  try {
    const database = openRevisorDatabase(path);
    const base = {
      repository: "LUDIARS/Revisor",
      title: "old",
      status: "merged",
      checkStatus: "test_ok",
      headSha: "a".repeat(40),
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const inline = { ...base, id: "legacy-1", number: 1, anatomia: ANALYSIS, anatomiaGate: { status: "passed" } };
    // 入れ子に同じキー名があるだけの記録は、本体に解析結果を持っていない。
    const nested = { ...base, id: "legacy-2", number: 2, reviewPlan: { note: { anatomia: 1 } } };
    const insert = database.prepare("INSERT INTO pull_requests (id, record) VALUES (?, ?)");
    insert.run(inline.id, JSON.stringify(inline));
    insert.run(nested.id, JSON.stringify(nested));
    database.close();

    const store = createStore(path);
    for (const listed of store.listPullRequests()) assert.equal("anatomia" in listed, false);
    const restored = store.getPullRequest("legacy-1");
    assert.deepEqual(restored.anatomia, ANALYSIS);
    assert.deepEqual(restored.anatomiaGate, { status: "passed" });

    const moved = rawRows(path, "legacy-1");
    assert.equal("anatomia" in moved.main, false);
    assert.deepEqual(moved.side, ANALYSIS);
    assert.equal(moved.split, "1");
    const untouched = rawRows(path, "legacy-2");
    assert.deepEqual(untouched.main.reviewPlan, { note: { anatomia: 1 } });
    assert.equal(untouched.side, undefined);
  } finally {
    removeFixture(directory);
  }
});

test("an analysis written inline by a process on the old code wins until the next write moves it", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { anatomia: { stale: true } });

    // 旧コードの審査ワーカーは記録全体を本体へ書く。
    const writer = new DatabaseSync(path);
    try {
      const row = JSON.parse(
        writer.prepare("SELECT record FROM pull_requests WHERE id = ?").get(pullRequest.id).record,
      );
      writer
        .prepare("UPDATE pull_requests SET record = ? WHERE id = ?")
        .run(JSON.stringify({ ...row, anatomia: ANALYSIS }), pullRequest.id);
    } finally {
      writer.close();
    }

    assert.equal("anatomia" in store.listPullRequests()[0], false);
    assert.deepEqual(store.getPullRequest(pullRequest.id).anatomia, ANALYSIS);
    assert.deepEqual(store.getPullRequestAnatomia(pullRequest.id), ANALYSIS);

    store.appendPullRequestEvent(pullRequest.id, { event: "review", message: "done" });
    const raw = rawRows(path, pullRequest.id);
    assert.equal("anatomia" in raw.main, false);
    assert.deepEqual(raw.side, ANALYSIS);
  } finally {
    removeFixture(directory);
  }
});
