import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionSettingsKey,
  filterByState,
  ListResponseCache,
  listResponseBody,
  PrListCache,
  summaryProjection,
} from "../src/pr-list-cache.mjs";

test("caches a built list by version and decision settings", () => {
  const cache = new PrListCache();
  let builds = 0;
  const build = () => ({ builds: ++builds });
  const first = cache.read({ version: "1:0", settingsKey: "settings-a", build });
  assert.strictEqual(cache.read({ version: "1:0", settingsKey: "settings-a", build }), first);
  assert.equal(builds, 1);
  assert.notStrictEqual(cache.read({ version: "2:0", settingsKey: "settings-a", build }), first);
  assert.notStrictEqual(cache.read({ version: "2:0", settingsKey: "settings-b", build }), first);
  assert.equal(builds, 3);
});

test("does not cache lists without a version", () => {
  const cache = new PrListCache();
  let builds = 0;
  const build = () => ({ builds: ++builds });
  const unversioned = cache.read({ version: null, settingsKey: "settings", build });
  assert.notStrictEqual(cache.read({ version: null, settingsKey: "settings", build }), unversioned);
  assert.notStrictEqual(cache.read({ version: "1:0", settingsKey: "settings", build }), unversioned);
  assert.equal(builds, 3);
});

test("keys only settings that affect pull request decisions", () => {
  const settings = {
    autoMergeEnabled: true,
    autoMergeRiskThreshold: "medium",
    autoMergeRequiresRuntimeVerificationClear: true,
    workerCount: 1,
  };
  const key = decisionSettingsKey(settings);
  assert.equal(key, decisionSettingsKey({ ...settings, workerCount: 2 }));
  assert.notEqual(key, decisionSettingsKey({ ...settings, autoMergeEnabled: false }));
  assert.notEqual(key, decisionSettingsKey({ ...settings, autoMergeRiskThreshold: "high" }));
  assert.notEqual(key, decisionSettingsKey({ ...settings, autoMergeRequiresRuntimeVerificationClear: false }));
});

test("projects only the fields needed by PR cards", () => {
  const summary = summaryProjection({
    id: "pr-1", number: 1, repository: "LUDIARS/Revisor", title: "一覧を軽量化する",
    status: "open", checkStatus: "queued", createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z", decision: { state: "needs_human" },
    anatomia: {}, body: "details", ci: [], lifecycleEvents: [], reviewPlan: {}, mergeRisk: {},
  });
  assert.deepEqual(Object.keys(summary), [
    "id", "number", "repository", "title", "status", "checkStatus", "reviewLane",
    "createdAt", "updatedAt", "decision",
  ]);
  for (const field of ["anatomia", "body", "ci", "lifecycleEvents", "reviewPlan", "mergeRisk"]) {
    assert.equal(field in summary, false);
  }
});

test("filters PRs by requested state", () => {
  const pullRequests = [{ status: "open" }, { status: "merged" }, { status: "closed" }];
  assert.deepEqual(filterByState(pullRequests, "open"), [pullRequests[0]]);
  assert.deepEqual(filterByState(pullRequests, "merged"), [pullRequests[1]]);
  assert.deepEqual(filterByState(pullRequests, "closed"), [pullRequests[2]]);
  assert.strictEqual(filterByState(pullRequests, "all"), pullRequests);
});

test("serializes summary projections and preserves full all records", () => {
  const pullRequests = [{
    id: "pr-1", number: 1, repository: "LUDIARS/Revisor", title: "一覧を軽量化する",
    status: "open", checkStatus: "queued", reviewLane: "standard",
    createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z",
    decision: { state: "needs_human" }, body: "full",
  }];
  assert.deepEqual(JSON.parse(listResponseBody(pullRequests, { view: "summary", state: "open" })), {
    pullRequests: [{
      id: "pr-1", number: 1, repository: "LUDIARS/Revisor", title: "一覧を軽量化する",
      status: "open", checkStatus: "queued", reviewLane: "standard",
      createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z",
      decision: { state: "needs_human" },
    }],
  });
  assert.equal(listResponseBody(pullRequests, { view: "full", state: "all" }), JSON.stringify({ pullRequests }));
});

test("caches list response bodies by source and view-state key", () => {
  const cache = new ListResponseCache();
  const source = [];
  let builds = 0;
  const build = () => `body-${++builds}`;
  assert.strictEqual(cache.render(source, "full|all", build), cache.render(source, "full|all", build));
  assert.equal(cache.render(source, "summary|open", build), "body-2");
  assert.equal(cache.render(source, "full|all", build), "body-1");
  assert.equal(cache.render([], "full|all", build), "body-3");
  assert.equal(builds, 3);
});
