// Two questions the dashboard has to answer at a glance, both derived from the
// evidence one review already produced:
//   - does a human have to actually run the product for this change?
//   - how risky is merging it without looking?
// Both are deterministic and fully itemised, so a human can disagree with the
// number by reading the factors instead of guessing at a black box.

// The reviewer is asked to emit this marker when the registered tests cannot
// establish that the change works.
export const RUNTIME_CHECK_MARKER = "REVISOR_NEEDS_RUNTIME_CHECK";

const RUNTIME_SURFACE_POINTS = {
  migration: 35,
  entrypoint: 30,
  ui: 25,
  infra: 20,
};

const KIND_SURFACE_POINTS = {
  infra: 14,
  config: 8,
  code: 6,
  test: 2,
  generated: 2,
  asset: 2,
  docs: 0,
};

const RISK_BANDS = [
  { band: "low", label: "低", max: 20 },
  { band: "moderate", label: "中", max: 45 },
  { band: "high", label: "高", max: 75 },
  { band: "critical", label: "重大", max: Infinity },
];

// A runtime test case that ran and passed is direct evidence, so it buys the
// score down. It does not zero it: a passing smoke test does not prove a
// migration or a release entrypoint is safe.
const RUNTIME_EVIDENCE_CREDIT = 40;

function clamp(value, maximum = 100) {
  return Math.max(0, Math.min(maximum, Math.round(value)));
}

export function riskBandOf(score) {
  return RISK_BANDS.find((entry) => score <= entry.max) ?? RISK_BANDS.at(-1);
}

function passedRuntimeTests({ testCases = [], ci = [] }) {
  const runtimeNames = new Set(
    testCases.filter((testCase) => testCase.runtime === true).map((testCase) => testCase.name),
  );
  return ci
    .filter((entry) => runtimeNames.has(entry.name) && entry.status === "passed")
    .map((entry) => entry.name);
}

export function assessRuntimeVerification({
  classification,
  testCases = [],
  ci = [],
  reviewerOutput = "",
  architectureErrorCount = 0,
}) {
  const factors = [];
  for (const surface of classification.runtimeSurfaces) {
    const points = RUNTIME_SURFACE_POINTS[surface];
    if (points) {
      factors.push({
        code: `surface:${surface}`,
        points,
        detail: `${surface} に触れる変更は登録テストだけでは動作を保証できません`,
      });
    }
  }
  const hasExecutable = classification.kinds.some((kind) =>
    kind === "code" || kind === "infra" || kind === "config");
  const runtimeTestNames = testCases
    .filter((testCase) => testCase.runtime === true)
    .map((testCase) => testCase.name);
  if (hasExecutable && runtimeTestNames.length === 0) {
    factors.push({
      code: "no_runtime_test_registered",
      points: 20,
      detail: "runtime: true の登録テストケースがありません",
    });
  }
  if (architectureErrorCount > 0) {
    factors.push({
      code: "architecture_error",
      points: 20,
      detail: `severity=error のアーキテクチャ違反 ${architectureErrorCount} 件`,
    });
  }
  if (String(reviewerOutput).includes(RUNTIME_CHECK_MARKER)) {
    factors.push({
      code: "reviewer_marker",
      points: 30,
      detail: "レビュアーが動作確認を要求しました",
    });
  }
  const evidence = passedRuntimeTests({ testCases, ci });
  const raw = factors.reduce((total, factor) => total + factor.points, 0);
  if (evidence.length > 0) {
    factors.push({
      code: "runtime_test_passed",
      points: -Math.min(RUNTIME_EVIDENCE_CREDIT, raw),
      detail: `動作テスト ${evidence.join(", ")} が通過しました`,
    });
  }
  const score = clamp(factors.reduce((total, factor) => total + factor.points, 0));
  return {
    score,
    required: score >= 25,
    factors,
    evidence,
  };
}

export function assessMergeRisk({
  classification,
  reasons = [],
  advisories = [],
  analysis = null,
  complexityScoreDelta = null,
  leakage = null,
  ci = [],
  runtimeVerification,
  plan = null,
  docsOnly = false,
}) {
  const factors = [];
  const add = (code, points, detail) => {
    if (points > 0) factors.push({ code, points, detail });
  };

  if (leakage && leakage.totalFindings > 0) {
    add("leakage", 100, `情報流出候補 ${leakage.totalFindings} 件`);
  }
  const failedTests = ci.filter((entry) => entry.status === "failed");
  add("failed_tests", failedTests.length > 0 ? 40 : 0, `登録テスト ${failedTests.length} 件が失敗`);

  const architecture = analysis?.architecture ?? {};
  const changedViolations = architecture.changedViolations ?? [];
  const errorViolations = changedViolations.filter((entry) => entry.severity === "error");
  add(
    "architecture_error",
    Math.min(60, errorViolations.length * 20),
    `severity=error のアーキテクチャ違反 ${errorViolations.length} 件`,
  );
  add(
    "architecture_advisory",
    Math.min(12, (changedViolations.length - errorViolations.length) * 4),
    `error 未満のアーキテクチャ違反 ${changedViolations.length - errorViolations.length} 件`,
  );
  if (analysis?.domain && analysis.domain.hasTargetDomain === false && !docsOnly) {
    add("missing_domain", 20, "対象ドメインが未定義です");
  }
  if (typeof complexityScoreDelta === "number" && complexityScoreDelta < 0) {
    add(
      "complexity_drop",
      Math.min(20, -complexityScoreDelta),
      `complexity スコアが ${-complexityScoreDelta} 低下`,
    );
  }
  const orphans = analysis?.quality?.changedOrphans ?? [];
  add("orphans", Math.min(12, orphans.length * 4), `孤立した変更関数 ${orphans.length} 件`);

  add(
    "diff_size",
    Math.min(
      18,
      Math.floor(classification.changedLines / 150) * 3
        + Math.floor(classification.changedFiles / 5) * 2,
    ),
    `${classification.changedFiles} ファイル / ${classification.changedLines} 行の変更`,
  );
  const surfacePoints = Math.max(
    0,
    ...classification.kinds.map((kind) => KIND_SURFACE_POINTS[kind] ?? 6),
  );
  add(
    "change_surface",
    surfacePoints,
    `変更種別 ${classification.kinds.join("/") || "(なし)"}`,
  );

  if (runtimeVerification?.required) {
    add("runtime_verification", 20, "人間による動作確認が必要な変更です");
  } else if (runtimeVerification?.score > 0) {
    add(
      "runtime_verification",
      Math.min(8, Math.round(runtimeVerification.score / 5)),
      "動作確認の必要性が部分的に残ります",
    );
  }
  // An advised skip trades cost for confidence. Saying so in the score keeps the
  // trade visible instead of making a thinner review look identically safe.
  const advisedSkips = plan?.advisedSkips ?? [];
  add(
    "advised_skips",
    Math.min(9, advisedSkips.length * 3),
    `管制プランナーが ${advisedSkips.length} 件のステージを省略`,
  );
  if (reasons.length > 0) {
    add("blocking_reasons", 100, `マージブロック理由 ${reasons.length} 件`);
  }
  add("advisories", Math.min(6, advisories.length * 2), `所見 ${advisories.length} 件`);

  const score = clamp(factors.reduce((total, factor) => total + factor.points, 0));
  const { band, label } = riskBandOf(score);
  return { score, band, bandLabel: label, factors };
}
