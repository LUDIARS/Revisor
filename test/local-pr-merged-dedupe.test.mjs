import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalPrStore } from "../src/state-store.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-merged-dedupe-"));
  let id = 0;
  const store = new LocalPrStore({
    path: join(directory, "revisor.db"),
    createId: () => `id-${++id}`,
    now: () => "2026-11-26T00:00:00.000Z",
  });
  return { store, directory };
}

function submit(store, headSha) {
  return store.createPullRequestIfAbsent({
    repository: "LUDIARS/Portus",
    title: "feat(file-follow)",
    body: "",
    author: "neco",
    headRef: "feat/file-follow",
    baseRef: "main",
    headSha,
    baseSha: "b".repeat(40),
  }).pullRequest;
}

test("finds the merged pull request for a resubmitted head", (t) => {
  const { store, directory } = createStore();
  t.after(() => removeFixture(directory));
  const head = "e".repeat(40);
  const first = submit(store, head);
  store.updatePullRequest(first.id, { status: "merged" });

  // The open-only lookup no longer sees it, so the resubmission used to create a second PR.
  assert.equal(store.findExactPullRequest("LUDIARS/Portus", head), null);
  const merged = store.findMergedPullRequestByHead("ludiars/portus", head.toUpperCase());
  assert.equal(merged?.id, first.id);
  assert.equal(merged?.status, "merged");
});

test("does not match a different head or an open pull request", (t) => {
  const { store, directory } = createStore();
  t.after(() => removeFixture(directory));
  const open = submit(store, "c".repeat(40));
  assert.equal(store.findMergedPullRequestByHead("LUDIARS/Portus", "c".repeat(40)), null);
  store.updatePullRequest(open.id, { status: "merged" });
  assert.equal(store.findMergedPullRequestByHead("LUDIARS/Portus", "d".repeat(40)), null);
});
