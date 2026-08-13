import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionSettingsKey,
  PrListCache,
  SerializedListBody,
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

test("serializes a list only once per array reference", () => {
  const cache = new SerializedListBody();
  const source = [];
  let builds = 0;
  const build = () => `body-${++builds}`;
  assert.strictEqual(cache.render(source, build), cache.render(source, build));
  assert.equal(cache.render([], build), "body-2");
  assert.equal(builds, 2);
});
