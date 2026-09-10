/**
 * @spec Comparable function complexity
 *
 * 集計スコアの差分は「母集団が変わっただけ」でも動く。 機能追加で呼び出し可能な
 * 関数が増えると平均 call fan-out が動き、 既存関数が悪化していなくても
 * complexity gate が落ちる (`spec/plan/problem_logs/2026-09-08-complexity-population-change.md`)。
 *
 * そこで版付き Anatomia スナップショット同士を突き合わせ、 **同一と見なせた関数**
 * だけを比較する。 追加・削除は別枠で数え、 悪化の最悪値だけを既存しきい値へ渡す。
 * スナップショットが無い/壊れている場合は従来の集計比較へ落ちる。
 * いずれの比較結果も advisory であり、マージ阻害要因にはしない。
 */

const METRIC = "call-out-degree-plus-one";

// Anatomia が報告する metric は呼び出し出次数 + 1 なので、 値が大きいほど悪い。
// 集計スコアと同じ向き (大きいほど良い) へ写像してから差分を取る。
const score = (value) => Math.round(100 / (1 + Math.max(0, value - 1) / 4));

/**
 * 比較に使えるスナップショットか。
 *
 * `expectedCount` は同じ解析が数えた関数数。 一致しない (= 取りこぼした)
 * スナップショットで比較すると、 実在する悪化を「対象外」として見逃すので、
 * ここで弾いて集計比較へ落とす。
 */
function valid(snapshot, expectedCount) {
  return snapshot?.version === 1
    && snapshot.metric === METRIC
    && Array.isArray(snapshot.functions)
    && typeof expectedCount === "number"
    && snapshot.functions.length === expectedCount
    && snapshot.functions.every((row) =>
      typeof row.key === "string"
      && row.key.length > 0
      && (row.structuralHash === null || typeof row.structuralHash === "string")
      && Number.isInteger(row.value)
      && row.value >= 1);
}

function index(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

/**
 * 従来の集計スコア比較。 母集団が空の基準は Anatomia の中立値 100 でしかなく、
 * 新設コード領域の基準として比較できないので、 差分を出さない。
 */
function legacy(before, after, reason) {
  const baseFunctions = before?.complexity?.functions;
  const baseScore = before?.complexity?.score;
  const headScore = after?.complexity?.score;
  const comparable = typeof baseFunctions === "number" && baseFunctions > 0
    && typeof baseScore === "number"
    && typeof headScore === "number";
  return {
    mode: "legacy-aggregate",
    metric: METRIC,
    reason,
    delta: comparable ? headScore - baseScore : null,
  };
}

/** Compare unchanged identities, then uniquely moved identical bodies. */
export function compareComplexity(before, after) {
  const base = before?.functionComplexity;
  const head = after?.functionComplexity;
  if (!valid(base, before?.complexity?.functions) || !valid(head, after?.complexity?.functions)) {
    return legacy(before, after, "Function snapshots unavailable or invalid");
  }
  const remainingBase = new Set(base.functions);
  const remainingHead = new Set(head.functions);
  const pairs = [];
  // `index` は呼ぶたびに残りから作り直すので、 ループ中の Set 更新と競合しない。
  const match = (field, rejectAmbiguous) => {
    const old = index(remainingBase, field);
    const next = index(remainingHead, field);
    for (const [key, rows] of old) {
      const targets = next.get(key);
      if (!targets) continue;
      // 同名同型が複数あると、 どれがどれの後継か決められない。 identity 突合では
      // 誤った組で悪化を打ち消しかねないので比較そのものを諦める。 body 突合では
      // その組を諦めて「追加/削除」として数えるだけにする。
      if (rows.length !== 1 || targets.length !== 1) {
        if (rejectAmbiguous) return false;
        continue;
      }
      pairs.push([rows[0], targets[0]]);
      remainingBase.delete(rows[0]);
      remainingHead.delete(targets[0]);
    }
    return true;
  };
  if (!match("key", true)) return legacy(before, after, "Ambiguous existing function identities");
  match("structuralHash", false);
  // 本体が変わっていないのに metric が動いた分。 新しい記号解決で呼び出し辺が
  // 増えただけで、 その関数の著者が複雑にしたわけではないので悪化に数えない。
  const unchangedBody = ([old, next]) =>
    old.structuralHash !== null && old.structuralHash === next.structuralHash;
  const graphContextChanges = pairs
    .filter((pair) => unchangedBody(pair) && pair[0].value !== pair[1].value)
    .length;
  const regressions = pairs
    .filter((pair) => pair[1].value > pair[0].value && !unchangedBody(pair))
    .map(([old, next]) => ({
      key: next.key,
      before: old.value,
      after: next.value,
      scoreDelta: score(next.value) - score(old.value),
    }));
  // A new/simple function or improvement elsewhere cannot dilute a regression.
  const delta = regressions.reduce((worst, row) => Math.min(worst, row.scoreDelta), 0);
  return {
    mode: "matched-functions",
    metric: METRIC,
    compared: pairs.length,
    added: remainingHead.size,
    removed: remainingBase.size,
    addedMaximum: [...remainingHead].reduce((max, row) => Math.max(max, row.value), 0),
    delta: pairs.length > 0 ? delta : null,
    graphContextChanges,
    regressions,
  };
}
