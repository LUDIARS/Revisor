import assert from "node:assert/strict";
import test from "node:test";
import { deferredPublications } from "../src/publication-state.mjs";

// 保留は「後で送る」を人間が覚えていないと永久に送られない。 盤面から辿れる形にするための
// 射影 (Memoria #862)。 出所は state の `publication` 列で、 merge repository の git は触らない。

test("projects only the merges that are still deferred", () => {
  const pending = deferredPublications([
    { repository: "LUDIARS/A", number: 1, publication: "published", mergedAt: "2026-09-01T00:00:00.000Z" },
    {
      repository: "LUDIARS/A",
      number: 2,
      title: "add thing",
      publication: "deferred",
      deferredPublishReason: "GitHub App is not installed",
      mergeCommitSha: "abc1234",
      mergedAt: "2026-09-02T00:00:00.000Z",
    },
    { repository: "LUDIARS/B", number: 3, publication: undefined },
  ]);

  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], {
    repository: "LUDIARS/A",
    number: 2,
    title: "add thing",
    mergeCommitSha: "abc1234",
    reason: "GitHub App is not installed",
    mergedAt: "2026-09-02T00:00:00.000Z",
  });
});

test("returns nothing when no merge is deferred", () => {
  assert.deepEqual(deferredPublications([{ publication: "published" }]), []);
  assert.deepEqual(deferredPublications([]), []);
  assert.deepEqual(deferredPublications(), []);
});

// 古い保留ほど忘れられているので先に出す。
test("orders the oldest deferral first and keeps undated records last", () => {
  const pending = deferredPublications([
    { repository: "R", number: 3, publication: "deferred", mergedAt: "2026-09-03T00:00:00.000Z" },
    { repository: "R", number: 9, publication: "deferred" },
    { repository: "R", number: 1, publication: "deferred", mergedAt: "2026-09-01T00:00:00.000Z" },
  ]);

  assert.deepEqual(pending.map((entry) => entry.number), [1, 3, 9]);
});

// 記録が欠けていても一覧そのものは出す。 表示側で '—' に落とせる形にしておく。
test("fills missing fields with nulls instead of dropping the row", () => {
  const [entry] = deferredPublications([{ repository: "R", publication: "deferred" }]);

  assert.equal(entry.number, null);
  assert.equal(entry.title, "");
  assert.equal(entry.reason, null);
  assert.equal(entry.mergeCommitSha, null);
  assert.equal(entry.mergedAt, null);
});
