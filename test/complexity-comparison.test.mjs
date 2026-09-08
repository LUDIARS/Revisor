import { test } from "node:test";
import assert from "node:assert/strict";
import { compareComplexity } from "../src/complexity-comparison.mjs";

const row = (key, value, structuralHash = null) => ({ key, value, structuralHash });

const quality = (functions, score = 80) => ({
  complexity: { functions: functions.length, score },
  functionComplexity: { version: 1, metric: "call-out-degree-plus-one", functions },
});

test("new feature population does not manufacture regression", () => {
  const result = compareComplexity(quality([row("a", 1)]), quality([row("a", 1), row("b", 8)]));
  assert.equal(result.delta, 0);
  assert.equal(result.added, 1);
  assert.equal(result.addedMaximum, 8);
  // 基準に関数が 1 つも無ければ、 比較できる過去は存在しない。
  assert.equal(compareComplexity(quality([]), quality([row("a", 8)])).delta, null);
});

test("many trivial additions and another improvement cannot hide existing regression", () => {
  const result = compareComplexity(
    quality([row("a", 1), row("b", 8)]),
    quality([
      row("a", 5),
      row("b", 1),
      ...Array.from({ length: 100 }, (_, i) => row("new" + i, 1)),
    ]),
  );
  assert.equal(result.delta, -50);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].key, "a");
});

test("unique unchanged bodies preserve identity across moves", () => {
  const result = compareComplexity(quality([row("old", 3, "body")]), quality([row("new", 3, "body")]));
  assert.equal(result.compared, 1);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.delta, 0);
});

test("removal never credits an unrelated existing regression", () => {
  const result = compareComplexity(
    quality([row("a", 1), row("deleted", 100)]),
    quality([row("a", 2)]),
  );
  assert.equal(result.removed, 1);
  assert.equal(result.delta, -20);
});

test("ambiguous identities and old or invalid reports retain legacy gating", () => {
  const base = quality([row("a", 1)], 100);
  const ambiguous = quality([row("a", 2), row("a", 3)]);
  assert.equal(compareComplexity(base, ambiguous).mode, "legacy-aggregate");
  assert.equal(compareComplexity(base, ambiguous).delta, -20);

  const missingSnapshot = quality([row("a", 2), row("a", 3)]);
  delete missingSnapshot.functionComplexity;
  assert.equal(compareComplexity(base, missingSnapshot).mode, "legacy-aggregate");
  assert.equal(compareComplexity(base, missingSnapshot).delta, -20);

  assert.equal(compareComplexity(base, quality([row("a", Number.NaN)])).mode, "legacy-aggregate");
});

test("unchanged source is not regressed by newly resolved graph edges", () => {
  const result = compareComplexity(
    quality([row("a", 1, "same-body")]),
    quality([row("a", 2, "same-body")]),
  );
  assert.equal(result.delta, 0);
  assert.equal(result.graphContextChanges, 1);

  const edited = compareComplexity(
    quality([row("a", 1, "old-body")]),
    quality([row("a", 2, "new-body")]),
  );
  assert.equal(edited.delta, -20);
  assert.equal(edited.graphContextChanges, 0);
});

test("incomplete snapshots never turn a measured baseline into no comparison", () => {
  const base = quality([row("a", 1)], 100);
  const head = quality([row("a", 4)]);
  head.functionComplexity.functions = [];
  assert.equal(compareComplexity(base, head).mode, "legacy-aggregate");
  assert.equal(compareComplexity(base, head).delta, -20);
});

test("a missing aggregate score falls back without throwing", () => {
  // 解析成果の投影によっては `complexity` が欠ける。 比較器は落ちずに
  // 「比較対象なし」を返さなければならない。
  assert.deepEqual(
    compareComplexity(undefined, {}),
    {
      mode: "legacy-aggregate",
      metric: "call-out-degree-plus-one",
      reason: "Function snapshots unavailable or invalid",
      delta: null,
    },
  );
  assert.equal(compareComplexity(quality([row("a", 1)], 100), {}).delta, null);
});

test("a reused baseline without a function count keeps the legacy gate", () => {
  // 部分再検証はチェックポイントから基準を組み直す。 関数数が残っていなければ
  // スナップショットの取りこぼしを検出できないので、 集計比較へ落とす。
  const base = {
    complexity: { score: 100 },
    functionComplexity: {
      version: 1,
      metric: "call-out-degree-plus-one",
      functions: [row("a", 1)],
    },
  };
  const result = compareComplexity(base, quality([row("a", 4)]));
  assert.equal(result.mode, "legacy-aggregate");
  assert.equal(result.delta, null);
});
