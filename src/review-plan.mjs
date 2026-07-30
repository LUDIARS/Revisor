// Not every change deserves every check. The plan is decided once, before the
// review runs, from the change profile: a documentation edit does not need a
// vulnerability pass or code-analysis gating, but it does still need the
// Anatomia domain review and the spec-requirement check (neco 2026-07-30).

export const REVIEW_STAGES = [
  {
    id: "leakage_scan",
    label: "情報流出スキャン",
    // The only reason this workflow exists is keeping branches and secrets off
    // the remote. No plan, deterministic or advised, may switch it off.
    mandatory: true,
  },
  { id: "registered_tests", label: "登録テスト", mandatory: false },
  { id: "anatomia_code_analysis", label: "Anatomia コード解析", mandatory: false },
  { id: "anatomia_domain_review", label: "Anatomia ドメインレビュー", mandatory: true },
  { id: "spec_requirements", label: "spec 要件充足確認", mandatory: true },
  { id: "security_review", label: "脆弱性診断", mandatory: false },
  { id: "reviewer_autofix", label: "相互モデルレビュー", mandatory: true },
];

export const STAGE_IDS = REVIEW_STAGES.map((stage) => stage.id);

const MANDATORY_STAGE_IDS = new Set(
  REVIEW_STAGES.filter((stage) => stage.mandatory).map((stage) => stage.id),
);

// Kinds that carry no executable behaviour. A change made up only of these
// needs no code analysis and no vulnerability pass.
const INERT_KINDS = new Set(["docs", "asset", "generated"]);

// Kinds whose test coverage may never be dropped by an advisor: skipping tests
// on executable change is exactly the failure this plan must not enable.
const EXECUTABLE_KINDS = new Set(["code", "infra", "config", "test"]);

export function isMandatoryStage(id) {
  return MANDATORY_STAGE_IDS.has(id);
}

export function hasExecutableChange(classification) {
  return classification.kinds.some((kind) => !INERT_KINDS.has(kind));
}

// A test case declares the change kinds it covers. Without that metadata the
// case is treated as covering executable change only, so a documentation edit
// no longer pays for the full suite while nothing that touches code loses a
// check. `always: true` opts a case out of every skip.
function testCaseCoverage(testCase) {
  if (testCase.always === true) return { kinds: null, always: true };
  if (Array.isArray(testCase.kinds) && testCase.kinds.length > 0) {
    return { kinds: testCase.kinds, always: false };
  }
  return { kinds: [...EXECUTABLE_KINDS], always: false };
}

function selectTestCases(testCases, classification) {
  const selected = [];
  const skipped = [];
  for (const testCase of testCases) {
    const coverage = testCaseCoverage(testCase);
    if (coverage.always || coverage.kinds.some((kind) => classification.kinds.includes(kind))) {
      selected.push(testCase.name);
      continue;
    }
    skipped.push({
      name: testCase.name,
      reason: `変更種別 ${classification.kinds.join("/") || "(なし)"} を担当しないテストケースです`,
    });
  }
  return { selected, skipped };
}

function stageDecisions(classification) {
  const executable = hasExecutableChange(classification);
  return {
    leakage_scan: { run: true, reason: "情報流出検査は変更種別に関係なく必須です" },
    anatomia_code_analysis: executable
      ? { run: true, reason: "実行されるコードを含む変更です" }
      : {
          run: false,
          reason: `実行コードを含まない変更 (${classification.kinds.join("/")}) です`,
        },
    anatomia_domain_review: {
      run: true,
      reason: "ドキュメントも自身がドメインであり、ドメイン整合は常に確認します",
    },
    spec_requirements: { run: true, reason: "spec 要件の充足確認は常に行います" },
    security_review: executable
      ? { run: true, reason: "実行されるコードを含む変更です" }
      : {
          run: false,
          reason: `実行コードを含まない変更 (${classification.kinds.join("/")}) には脆弱性診断は不要です`,
        },
    reviewer_autofix: { run: true, reason: "相互モデルレビューは常に行います" },
  };
}

export function planReview({ classification, testCases = [] }) {
  const decisions = stageDecisions(classification);
  const tests = selectTestCases(testCases, classification);
  const stages = STAGE_IDS.map((id) => {
    if (id === "registered_tests") {
      return tests.selected.length > 0
        ? { id, run: true, reason: `${tests.selected.length} 件のテストケースが変更種別を担当します` }
        : { id, run: false, reason: "変更種別を担当する登録テストケースがありません" };
    }
    return { id, ...decisions[id] };
  });
  return {
    source: "deterministic",
    advisor: null,
    advisorError: null,
    changeProfile: {
      kinds: classification.kinds,
      counts: classification.counts,
      changedFiles: classification.changedFiles,
      changedLines: classification.changedLines,
      docsOnly: classification.docsOnly,
      touchesSpec: classification.touchesSpec,
      runtimeSurfaces: classification.runtimeSurfaces,
    },
    stages,
    testSelection: tests,
    // Stages an advisor turned off. Kept separate from the deterministic skips
    // because reduced confidence from an advised skip is itself a risk factor.
    advisedSkips: [],
  };
}

export function stageEnabled(plan, id) {
  if (!plan) return true;
  const stage = plan.stages?.find((candidate) => candidate.id === id);
  return stage ? stage.run !== false : true;
}

// Whether the review may still block on code-analysis findings. The demotion in
// `review-gate.mjs` rests on "the change owes no such evidence", which is only
// true of the deterministic skip: a change with no executable content has nothing
// for the quality and architecture rules to say. An advised skip is different —
// the head analysis ran either way, so its findings are real, and a control
// planner must not be able to turn a blocking architecture error into an advisory
// by declaring the stage unnecessary.
export function codeAnalysisGating(plan) {
  if (stageEnabled(plan, "anatomia_code_analysis")) return true;
  return (plan?.advisedSkips ?? []).some((entry) => entry.id === "anatomia_code_analysis");
}

export function selectedTestCases(plan, testCases) {
  if (!plan) return testCases;
  const selected = new Set(plan.testSelection?.selected ?? []);
  return testCases.filter((testCase) => selected.has(testCase.name));
}

export function skippedTestOutcomes(plan) {
  return (plan?.testSelection?.skipped ?? []).map((entry) => ({
    name: entry.name,
    status: "skipped",
    exitCode: null,
    durationMs: 0,
    reason: entry.reason,
  }));
}

// Applied to whatever an advisor returns. The advisor may re-enable anything and
// may relax only the optional code-analysis and vulnerability stages; it may
// drop test coverage only when the change contains nothing executable.
export function applyAdvisedPlan(plan, advice) {
  if (!advice || typeof advice !== "object") return plan;
  const executable = plan.changeProfile.kinds.some((kind) => EXECUTABLE_KINDS.has(kind));
  const requested = new Map(
    Array.isArray(advice.stages)
      ? advice.stages
          .filter((stage) => stage && typeof stage.id === "string")
          .map((stage) => [stage.id, stage])
      : [],
  );
  const advisedSkips = [];
  const stages = plan.stages.map((stage) => {
    const request = requested.get(stage.id);
    if (!request || typeof request.run !== "boolean") return stage;
    const reason = typeof request.reason === "string" && request.reason.trim()
      ? request.reason.trim().slice(0, 300)
      : "管制プランナーの判断";
    if (request.run) {
      return stage.run ? stage : { id: stage.id, run: true, reason: `${reason} (管制プランナーが追加)` };
    }
    if (isMandatoryStage(stage.id)) {
      return stage.run
        ? { ...stage, reason: `${stage.reason} (管制プランナーの省略要求は必須ステージのため却下)` }
        : stage;
    }
    if (stage.id === "registered_tests" && executable) {
      return {
        ...stage,
        reason: `${stage.reason} (実行コードを含むため管制プランナーの省略要求は却下)`,
      };
    }
    if (!stage.run) return stage;
    advisedSkips.push({ id: stage.id, reason });
    return { id: stage.id, run: false, reason: `${reason} (管制プランナー判断)` };
  });
  // A disabled stage already means "no registered test runs", so the selection
  // follows it instead of being narrowed a second time under its own reason.
  const testsEnabled = stages.find((stage) => stage.id === "registered_tests")?.run !== false;
  const testSelection = testsEnabled
    ? advisedTestSelection(plan, advice, executable, advisedSkips)
    : {
        selected: [],
        skipped: [
          ...plan.testSelection.skipped,
          ...plan.testSelection.selected.map((name) => ({
            name,
            reason: "管制プランナーが登録テストを不要と判断しました",
          })),
        ],
      };
  return {
    ...plan,
    source: "advised",
    advisor: typeof advice.advisor === "string" ? advice.advisor : plan.advisor,
    stages,
    testSelection,
    advisedSkips,
  };
}

function advisedTestSelection(plan, advice, executable, advisedSkips) {
  const known = new Set([
    ...plan.testSelection.selected,
    ...plan.testSelection.skipped.map((entry) => entry.name),
  ]);
  const requested = Array.isArray(advice.testCases)
    ? advice.testCases.filter((name) => typeof name === "string" && known.has(name))
    : null;
  if (!requested) return plan.testSelection;
  const added = requested.filter((name) => !plan.testSelection.selected.includes(name));
  const dropped = plan.testSelection.selected.filter((name) => !requested.includes(name));
  // Re-enabling is always allowed; dropping coverage is not, on executable
  // change. Without this an advisor could silently disable the whole suite.
  const selected = executable
    ? [...new Set([...plan.testSelection.selected, ...added])]
    : [...new Set(requested)];
  if (!executable && dropped.length > 0) {
    advisedSkips.push({
      id: "registered_tests",
      reason: `管制プランナーが ${dropped.join(", ")} を省略しました`,
    });
  }
  const skipped = plan.testSelection.skipped
    .filter((entry) => !selected.includes(entry.name))
    .concat(dropped
      .filter((name) => !selected.includes(name))
      .map((name) => ({ name, reason: "管制プランナーが変更に不要と判断しました" })));
  return { selected, skipped };
}
