import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listResponseBody } from "../src/pr-list-cache.mjs";
import { openRevisorDatabase } from "../src/revisor-db.mjs";
import {
  needsReviewReportSplit,
  splitInlineReviewReportBatch,
} from "../src/pull-request-review-report.mjs";
import { LocalPrStore } from "../src/state-store.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const REPORT = Object.freeze({
  version: 3,
  sections: [{ title: "登録テスト", body: "x".repeat(2000) }],
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-review-report-"));
  return { directory, path: join(directory, "revisor.db") };
}

function createStore(path) {
  let id = 0;
  return new LocalPrStore({
    path,
    createId: () => `id-${++id}`,
    now: () => "2026-10-03T00:00:00.000Z",
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
    const side = database.prepare("SELECT record FROM pull_request_review_reports WHERE id = ?").get(id);
    const split = database.prepare("SELECT value FROM meta WHERE key = 'review_report_split'").get();
    return {
      main: JSON.parse(main.record),
      side: side ? JSON.parse(side.record) : undefined,
      split: split?.value ?? null,
    };
  } finally {
    database.close();
  }
}

test("list records keep only the report version and single reads restore the report", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    assert.equal("reviewReport" in store.getPullRequest(pullRequest.id), false);

    store.updatePullRequest(pullRequest.id, { reviewReport: REPORT, checkStatus: "test_ok" });

    const [listed] = store.listPullRequests();
    assert.equal("reviewReport" in listed, false);
    assert.equal(listed.reviewReportVersion, 3);
    assert.equal(listed.checkStatus, "test_ok");

    const full = store.getPullRequest(pullRequest.id);
    assert.deepEqual(full.reviewReport, REPORT);
    // 版は一覧用の写しなので、完全な記録の形には出さない。
    assert.equal("reviewReportVersion" in full, false);

    const raw = rawRows(path, pullRequest.id);
    assert.equal("reviewReport" in raw.main, false);
    assert.equal(raw.main.reviewReportVersion, 3);
    assert.deepEqual(raw.side, REPORT);
    assert.equal(raw.split, "1");
  } finally {
    removeFixture(directory);
  }
});

test("status updates and events keep the stored report; a reset is kept as null", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { reviewReport: REPORT });
    store.updatePullRequest(pullRequest.id, { checkStatus: "running" });
    store.appendPullRequestEvent(pullRequest.id, { event: "review", message: "done" });
    assert.deepEqual(store.getPullRequest(pullRequest.id).reviewReport, REPORT);
    assert.equal(store.listPullRequests()[0].reviewReportVersion, 3);

    // patch 関数には本文を含む全体が渡る (完了通知・再審査が前回のレポートを読む)。
    let seen;
    store.updatePullRequestWith(pullRequest.id, (current) => {
      seen = current.reviewReport;
      return { title: "renamed" };
    });
    assert.deepEqual(seen, REPORT);

    store.updatePullRequest(pullRequest.id, { reviewReport: null });
    assert.equal(store.getPullRequest(pullRequest.id).reviewReport, null);
    assert.equal(store.listPullRequests()[0].reviewReportVersion, null);
  } finally {
    removeFixture(directory);
  }
});

test("opening an older database moves inline reports out once", () => {
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
    const inline = { ...base, id: "legacy-1", number: 1, reviewReport: REPORT };
    // 入れ子に同じキー名があるだけの記録は、本体にレポートを持っていない。
    const nested = { ...base, id: "legacy-2", number: 2, ci: { note: { reviewReport: 1 } } };
    const insert = database.prepare("INSERT INTO pull_requests (id, record) VALUES (?, ?)");
    insert.run(inline.id, JSON.stringify(inline));
    insert.run(nested.id, JSON.stringify(nested));
    database.close();

    const store = createStore(path);
    for (const listed of store.listPullRequests()) assert.equal("reviewReport" in listed, false);
    assert.deepEqual(store.getPullRequest("legacy-1").reviewReport, REPORT);

    const moved = rawRows(path, "legacy-1");
    assert.equal("reviewReport" in moved.main, false);
    assert.equal(moved.main.reviewReportVersion, 3);
    assert.deepEqual(moved.side, REPORT);
    assert.equal(moved.split, "1");
    const untouched = rawRows(path, "legacy-2");
    assert.deepEqual(untouched.main.ci, { note: { reviewReport: 1 } });
    assert.equal(untouched.side, undefined);
  } finally {
    removeFixture(directory);
  }
});

test("a report written inline by a process on the old code wins until the next write moves it", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { reviewReport: { version: 1 } });

    // 旧コードの審査ワーカーは記録全体を本体へ書く。
    const writer = new DatabaseSync(path);
    try {
      const row = JSON.parse(
        writer.prepare("SELECT record FROM pull_requests WHERE id = ?").get(pullRequest.id).record,
      );
      writer
        .prepare("UPDATE pull_requests SET record = ? WHERE id = ?")
        .run(JSON.stringify({ ...row, reviewReport: REPORT }), pullRequest.id);
    } finally {
      writer.close();
    }

    assert.equal("reviewReport" in store.listPullRequests()[0], false);
    assert.equal(store.listPullRequests()[0].reviewReportVersion, 3);
    assert.deepEqual(store.getPullRequest(pullRequest.id).reviewReport, REPORT);

    store.updatePullRequest(pullRequest.id, { checkStatus: "test_ok" });
    const raw = rawRows(path, pullRequest.id);
    assert.equal("reviewReport" in raw.main, false);
    assert.deepEqual(raw.side, REPORT);
  } finally {
    removeFixture(directory);
  }
});

test("the list include=reviewReport path reads report bodies from the side table", () => {
  const { directory, path } = fixture();
  const store = createStore(path);
  try {
    const pullRequest = submit(store);
    store.updatePullRequest(pullRequest.id, { reviewReport: REPORT });
    const listed = store.listPullRequests();

    const withReports = JSON.parse(listResponseBody(listed, {
      view: "full",
      state: "all",
      includeReviewReport: true,
      readReviewReports: (ids) => store.readReviewReports(ids),
    })).pullRequests;
    assert.deepEqual(withReports[0].reviewReport, REPORT);
    assert.equal("reviewReportVersion" in withReports[0], false);

    const without = JSON.parse(listResponseBody(listed, { view: "full", state: "all" })).pullRequests;
    assert.equal("reviewReport" in without[0], false);
    assert.equal(without[0].reviewReportVersion, 3);
    const summary = JSON.parse(listResponseBody(listed, { view: "summary", state: "all" })).pullRequests;
    assert.equal(summary[0].reviewReportVersion, 3);
  } finally {
    removeFixture(directory);
  }
});

test("the one-time move runs in small batches and finishes past records that only nest the key", () => {
  const { directory, path } = fixture();
  try {
    const database = openRevisorDatabase(path);
    const insert = database.prepare("INSERT INTO pull_requests (id, record) VALUES (?, ?)");
    for (let index = 1; index <= 5; index += 1) {
      const id = `legacy-${index}`;
      // 入れ子だけの記録をバッチの境目に挟む。 カーソルで先へ進めないと同じバッチを繰り返す。
      const record = index === 2
        ? { id, createdAt: `2026-09-0${index}T00:00:00.000Z`, ci: { note: { reviewReport: 1 } } }
        : { id, createdAt: `2026-09-0${index}T00:00:00.000Z`, reviewReport: { ...REPORT, version: index } };
      insert.run(id, JSON.stringify(record));
    }
    const batches = [];
    let afterId = "";
    for (;;) {
      const result = splitInlineReviewReportBatch(database, { afterId, limit: 2 });
      batches.push(result.moved);
      if (result.done) break;
      afterId = result.lastId;
    }
    assert.deepEqual(batches, [1, 2, 1, 0]);
    assert.equal(needsReviewReportSplit(database), false);
    const remaining = database
      .prepare("SELECT count(*) AS count FROM pull_requests WHERE instr(record, '\"reviewReport\":') > 0")
      .get().count;
    assert.equal(remaining, 1, "only the nested-key record still contains the key text");
    database.close();

    const store = createStore(path);
    assert.equal(store.getPullRequest("legacy-5").reviewReport.version, 5);
    assert.equal(store.listPullRequests().find((pr) => pr.id === "legacy-4").reviewReportVersion, 4);
  } finally {
    removeFixture(directory);
  }
});
