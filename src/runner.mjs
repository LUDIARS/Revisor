import { analyzePr, ensureInitialAnalysis, resolveAnatomiaCli } from "./anatomia.mjs";
import {
  evaluateAnatomiaReviewGate,
  runAnatomiaReviewGate,
} from "./anatomia-review-gate.mjs";
import { resolveWorkspaceRoot } from "./catalog.mjs";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
  optionalConcordiaUrl,
  targetDomainQuestion,
} from "./concordia-context.mjs";
import { readSettings } from "./config.mjs";
import { runPlannedTests, testsPassed } from "./ci.mjs";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { assessMergeRisk, assessRuntimeVerification } from "./merge-risk.mjs";
import { advisePlan } from "./plan-advisor.mjs";
import { runSecurityScan, skippedSecurityScan } from "./security-scan.mjs";
import {
  alternateReviewer,
  reviewerCapacityUnavailable,
  reviewerForProvider,
  runReviewer,
} from "./reviewer.mjs";
import { buildReviewerPrompt } from "./reviewer-prompt.mjs";
import {
  assertMeaningfulReviewDiff,
  investigationPrompt,
  selectReviewStrategy,
} from "./review-strategy.mjs";
import {
  buildTestAutofixPrompt,
  runTestAutofixLoop,
  isTestAutofixEnabled,
} from "./test-autofix.mjs";
import { gateOutcome, needsTargetDomain } from "./review-gate.mjs";
import { readChangeProfile } from "./review-diff.mjs";
import {
  codeAnalysisGating,
  applyCostValidationMode,
  planReview,
  planVerification,
  reviewTier,
  stageEnabled,
} from "./review-plan.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  git,
  prepareLocalWorktrees,
} from "./workspace.mjs";
import { REVIEW_WORK_STAGES } from "./review-work.mjs";
import { withWorktreeMutationLock } from "./worktree-mutation-lock.mjs";

async function commitAndAdvanceAutofix(cwd, repoPath, request) {
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status) {
    await git(cwd, ["add", "--all"]);
    await git(cwd, [
      "-c",
      "user.name=LUDIARS Revisor",
      "-c",
      "user.email=revisor@localhost",
      "commit",
      "-m",
      "fix(pr-review): apply automated review fixes",
      "-m",
      "Revisor-Autofix: true",
    ]);
  }
  const reviewedHead = await git(cwd, ["rev-parse", "HEAD"]);
  if (reviewedHead.toLowerCase() !== request.headSha.toLowerCase()) {
    await advanceLocalBranch(
      repoPath,
      request.headRef,
      request.headSha,
      reviewedHead,
    );
  }
  return reviewedHead;
}

function changeKindsDiffer(before, after) {
  const beforeKinds = before?.kinds ?? [];
  const afterKinds = after?.kinds ?? [];
  return beforeKinds.length !== afterKinds.length
    || beforeKinds.some((kind) => !afterKinds.includes(kind));
}

async function verifyAutofixPlan({ worktreePath, testCases, plan, env, runTests = runPlannedTests }) {
  const ci = await runTests({ worktreePath, testCases, plan, env });
  if (!testsPassed(ci)) {
    throw new Error(
      "Test autofix changed the review plan and the newly selected registered tests do not pass.",
    );
  }
  return ci;
}

async function worktreeChangeFingerprint(cwd) {
  const [diff, untracked] = await Promise.all([
    git(cwd, ["diff", "--binary", "HEAD", "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = untracked.split("\0").filter(Boolean);
  const hashes = [];
  for (const path of paths) {
    hashes.push([path, await git(cwd, ["hash-object", "--", path])]);
  }
  return JSON.stringify({ diff, hashes });
}

async function autofixFailingTests({
  request,
  reviewer,
  worktreePath,
  mergeBase,
  initialCi,
  testCases,
  plan,
  env,
  runReview,
  runTests = runPlannedTests,
  reviewerTimeoutMs,
}) {
  let activeReviewer = reviewer;
  const outcome = await runTestAutofixLoop({
    initialCi,
    repair: async ({ ci, attempt, maxAttempts }) => {
      const before = await worktreeChangeFingerprint(worktreePath);
      const result = await runReviewWithCapacityFallback({
        reviewer: activeReviewer,
        cwd: worktreePath,
        prompt: buildTestAutofixPrompt({ request, ci, attempt, maxAttempts }),
        timeoutMs: reviewerTimeoutMs,
        tier: "economy",
        effort: "low",
      }, runReview);
      activeReviewer = result.reviewer;
      if (!result.ok) return { ...result, changed: false };
      const profile = await readChangeProfile(worktreePath, mergeBase);
      const leakage = scanAddedDiffForLeaks(profile.unifiedDiff);
      if (leakage.totalFindings > 0) {
        throw new Error(
          "Test autofix introduced potential information leakage; changes were discarded before commit or push.",
        );
      }
      const after = await worktreeChangeFingerprint(worktreePath);
      return { ...result, changed: before !== after };
    },
    runTests: () => runTests({
      worktreePath,
      testCases,
      plan,
      env,
    }),
  });
  return { ...outcome, reviewer: activeReviewer };
}

function testAutofixHumanQuestion(status) {
  if (status === "model_failed") {
    return "Automated test autofix model failed; inspect the captured registered test evidence.";
  }
  if (status === "stalled") {
    return "Automated test autofix made no progress; inspect the failing test or environment.";
  }
  return "Registered tests still fail after the bounded automated autofix attempts.";
}

export async function runReviewWithCapacityFallback(options, execute) {
  if (typeof execute !== "function") {
    throw new TypeError("A reviewer executor function is required.");
  }
  const first = await execute(options);
  if (first.ok || !reviewerCapacityUnavailable(first)) {
    return { ...first, reviewer: options.reviewer };
  }
  const reviewer = alternateReviewer(options.reviewer);
  const second = await execute({ ...options, reviewer });
  return { ...second, reviewer };
}

// The baseline analysis exists only to produce a complexity delta, and the
// project-wide initial analysis only to report what the repository looks like. A
// plan that drops code analysis drops both runs, which is where most of the saved
// time comes from.
async function analyzeCodeBaseline({
  cliPath,
  repoPath,
  repository,
  worktrees,
  enabled,
  analyze = analyzePr,
  initialAnalyze = ensureInitialAnalysis,
}) {
  if (!enabled) return { firstAnalysis: null, baseline: null };
  const [firstAnalysis, baseline] = await Promise.all([
    initialAnalyze({ cliPath, repoPath, repository }),
    analyze({ cliPath, cwd: worktrees.base, base: "HEAD" }),
  ]);
  return { firstAnalysis, baseline };
}

function buildGateResult({
  request,
  firstAnalysis,
  finalAnalysis,
  baseline,
  reviewer,
  contextSource,
  reviewedHeadSha,
  reviewerOutput = "",
  complexityDropThreshold,
  initialLeakage,
  leakage,
  ci,
  docsOnly = false,
  docsOrConfigOnly = docsOnly,
  plan,
  classification,
  security,
  humanReviewRequired = false,
  geniusGuidance = null,
  intentReviewCompleted = false,
  anatomiaGate = null,
  analysisSource = "anatomia-cli",
  additionalReasons = [],
  additionalAdvisories = [],
}) {
  // A repository with no analyzed functions has Anatomia's neutral score of
  // 100. That score is not a comparable baseline for a newly introduced code
  // area, so only a measured baseline may enforce a complexity regression.
  const complexityScoreDelta = baseline
    && typeof baseline.quality.complexity.functions === "number"
    && baseline.quality.complexity.functions > 0
    ? finalAnalysis.quality.complexity.score - baseline.quality.complexity.score
    : null;
  const { reasons: gateReasons, advisories } = gateOutcome({
    finalAnalysis,
    complexityScoreDelta,
    threshold: complexityDropThreshold,
    reviewerOutput,
    leakage,
    ci,
    docsOnly,
    docsOrConfigOnly,
    codeDomainRequired: classification?.codeDomainRequired ?? true,
    domainReviewEnabled: stageEnabled(plan, "anatomia_domain_review"),
    plan,
    security,
    humanReviewRequired,
  });
  const reasons = [...new Set([...gateReasons, ...additionalReasons])];
  const runtimeVerification = assessRuntimeVerification({
    classification,
    testCases: request.testCases,
    ci,
    reviewerOutput,
    architectureErrorCount: codeAnalysisGating(plan)
      ? (finalAnalysis.architecture.changedViolations ?? [])
          .filter((violation) => violation.severity === "error").length
      : 0,
  });
  const mergeRisk = assessMergeRisk({
    classification,
    reasons,
    advisories,
    analysis: finalAnalysis,
    complexityScoreDelta,
    leakage,
    ci,
    runtimeVerification,
    plan,
    docsOnly,
  });
  return {
    conclusion: reasons.length === 0 ? "success" : "action_required",
    reviewMode: request.reviewMode,
    reviewer,
    intentReviewCompleted,
    contextSource,
    analysisSource,
    originalHeadSha: request.headSha,
    reviewedHeadSha,
    plan,
    initialAnalysis: firstAnalysis
      ? {
          project: firstAnalysis.project.id,
          files: firstAnalysis.analysis.files,
          functions: firstAnalysis.analysis.functions,
          cacheHit: firstAnalysis.analysis.cacheHit,
        }
      : null,
    analysis: finalAnalysis,
    baselineComplexityScore: baseline ? baseline.quality.complexity.score : null,
    baselineComplexityFunctionCount: baseline?.quality.complexity.functions ?? null,
    complexityScoreDelta,
    initialLeakage,
    leakage,
    ci,
    security,
    reasons,
    advisories: [
      ...advisories,
      ...additionalAdvisories,
      ...(anatomiaGate?.status === "unavailable" ? [anatomiaGate.message] : []),
    ],
    runtimeVerification,
    mergeRisk,
    geniusGuidance,
    anatomiaGate,
  };
}

function buildAnatomiaBlockedResult({
  request,
  gate,
  complexityDropThreshold,
  initialLeakage,
  leakage = initialLeakage,
  ci = [],
  docsOnly,
  docsOrConfigOnly,
  plan,
  classification,
  reviewer = "skipped",
  contextSource = "anatomia-review-gate",
}) {
  return {
    ...buildGateResult({
      request,
      firstAnalysis: null,
      finalAnalysis: gate.analysis,
      baseline: null,
      reviewer,
      contextSource,
      reviewedHeadSha: request.headSha,
      complexityDropThreshold,
      initialLeakage,
      leakage,
      ci,
      docsOnly,
      docsOrConfigOnly,
      plan,
      classification,
      security: null,
      anatomiaGate: gate,
      additionalReasons: gate.reasons,
    }),
    humanQuestion: "Resolve the Anatomia review-gate violations before LLM review can start.",
  };
}

// The security scan runs once per review pass and once right before the squash
// merge — never after the reviewer autofix, which the pre-merge scan covers. It
// is skipped while the leakage gate or the registered tests already block, so no
// potentially leaking diff reaches the scanner and no scan cost is wasted.
//
// It is also skipped when the review plan dropped the vulnerability stage. That
// is the whole point of planning: a change with no executable content has no
// attack surface to scan, and paying a per-scan cost cap to be told so is the
// waste the plan exists to remove. The skip is recorded with its reason, so the
// gate reports it as an advisory rather than passing silently.
async function reviewSecurityScan({ runSecurity, worktrees, leakage, ci, settings, plan }) {
  if (!stageEnabled(plan, "security_review")) {
    return skippedSecurityScan("not required by the review plan");
  }
  if (leakage.totalFindings > 0) return skippedSecurityScan("blocked by the leakage scan");
  if (!testsPassed(ci)) return skippedSecurityScan("registered tests failed");
  return runSecurity({
    worktreePath: worktrees.head,
    diffBase: worktrees.mergeBase,
    settings,
  });
}

function previousAnalysis(previousReview) {
  const anatomia = previousReview?.anatomia;
  if (!anatomia?.domain || !anatomia?.quality || !anatomia?.architecture) return null;
  return {
    domain: anatomia.domain,
    quality: anatomia.quality,
    architecture: anatomia.architecture,
  };
}

export async function runPartialVerification({
  request,
  submitted,
  settings,
  worktrees,
  anatomiaCliPath,
  env,
  runSecurity,
  complexityDropThreshold,
  analyze = analyzePr,
  runTests = runPlannedTests,
}) {
  const previous = request.previousReview;
  const targets = new Set(request.verificationTargets ?? []);
  // 載せ替えで SHA だけ変わったヘッドも同一内容として扱う。 判定は提出側が patch-id で
  // 行い、 request で渡ってくる (`local-pr-service.mjs`)。
  const sameReviewedHead = request.reviewedContentUnchanged === true || (
    typeof previous.reviewedHeadSha === "string"
    && previous.reviewedHeadSha.toLowerCase() === request.headSha.toLowerCase()
  );
  let analysis = targets.has("anatomia") ? null : previousAnalysis(previous);
  if (!targets.has("anatomia") && !analysis) {
    throw new Error("Partial verification requires the previous Anatomia result.");
  }
  const plan = planVerification({
    classification: submitted.classification,
    testCases: request.testCases,
    validationMode: settings,
  });
  const leakage = targets.has("leakage")
    ? scanAddedDiffForLeaks(submitted.unifiedDiff)
    : previous.leakage;
  if (!leakage) throw new Error("Partial verification requires the previous leakage result.");
  const ci = targets.has("tests")
    ? await runTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        plan,
        env,
      })
    : previous.ci;
  if (!Array.isArray(ci)) throw new Error("Partial verification requires the previous test result.");
  let baselineComplexity = typeof previous.anatomia?.baselineComplexityScore === "number"
    ? {
        score: previous.anatomia.baselineComplexityScore,
        ...(typeof previous.anatomia.baselineComplexityFunctionCount === "number"
          ? { functions: previous.anatomia.baselineComplexityFunctionCount }
          : {}),
      }
    : null;
  if (targets.has("anatomia")) {
    const [currentAnalysis, baseline] = await Promise.all([
      analyze({
        cliPath: anatomiaCliPath,
        cwd: worktrees.head,
        base: worktrees.mergeBase,
      }),
      stageEnabled(plan, "anatomia_code_analysis")
        ? analyze({
            cliPath: anatomiaCliPath,
            cwd: worktrees.base,
            base: "HEAD",
          })
        : null,
    ]);
    analysis = currentAnalysis;
    baselineComplexity = baseline?.quality?.complexity ?? null;
  }
  if (!analysis) throw new Error("Partial verification requires an Anatomia result.");
  const security = targets.has("security")
    ? await reviewSecurityScan({
        runSecurity,
        worktrees,
        leakage,
        ci,
        settings,
        plan,
      })
    : previous.security;
  const result = buildGateResult({
    request,
    firstAnalysis: null,
    finalAnalysis: analysis,
    baseline: baselineComplexity
      ? { quality: { complexity: baselineComplexity } }
      : null,
    reviewer: previous.reviewer,
    contextSource: `partial-verification:${[...targets].join(",")}`,
    reviewedHeadSha: request.headSha,
    complexityDropThreshold,
    initialLeakage: leakage,
    leakage,
    ci,
    docsOnly: submitted.classification.docsOnly,
    docsOrConfigOnly: submitted.classification.docsOrConfigOnly,
    plan,
    classification: submitted.classification,
    security,
    intentReviewCompleted: previous.intentReviewCompleted === true,
  });
  const runtimeVerification = sameReviewedHead
    ? (previous.runtimeVerification ?? result.runtimeVerification)
    : result.runtimeVerification;
  const mergeRisk = assessMergeRisk({
    classification: submitted.classification,
    reasons: result.reasons,
    advisories: result.advisories,
    analysis,
    complexityScoreDelta: result.complexityScoreDelta,
    leakage,
    ci,
    runtimeVerification,
    plan,
    docsOnly: submitted.classification.docsOnly,
  });
  return {
    ...result,
    runtimeVerification,
    mergeRisk,
    humanQuestion: needsTargetDomain(
      analysis,
      submitted.classification.docsOrConfigOnly,
      submitted.classification.codeDomainRequired,
      stageEnabled(plan, "anatomia_domain_review"),
    ) ? targetDomainQuestion(request.repository, request.number) : null,
  };
}

/**
 * Records the intent-review checkpoint. A failure here must not fail the
 * review: the checkpoint only saves work on a later run, and losing it costs
 * one more model review. It is reported rather than swallowed so a permanently
 * broken checkpoint does not stay invisible.
 */
async function reportIntentReviewCompleted(report, checkpoint) {
  if (typeof report !== "function") return;
  try {
    await report(checkpoint);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Revisor could not record the intent-review checkpoint for ${checkpoint.localPrId}: ${reason}\n`,
    );
  }
}

export function createPrReviewRunner({
  cwd,
  env = process.env,
  reviewerTimeoutMs = 30 * 60_000,
  complexityDropThreshold = 10,
  runReview = runReviewer,
  runSecurity = runSecurityScan,
  runTests = runPlannedTests,
  analyze = analyzePr,
  initialAnalyze = ensureInitialAnalysis,
  scheduleWork = null,
  mutateWorktrees = withWorktreeMutationLock,
  transport = fetch,
  // Checkpoint for the one stage that cannot be repeated cheaply. Called the
  // moment the intent review succeeds so that a crash later in the pipeline
  // does not throw that work away (spec/feature/crash-recovery.md).
  onIntentReviewCompleted = null,
} = {}) {
  return async (request) => {
    if (request.repository !== request.headRepository) {
      throw new Error("Fork pull requests are not eligible for the local autofix review");
    }
    const settings = readSettings(env);
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const repoPath = request.rootPath;
    const worktrees = await mutateWorktrees(
      repoPath,
      () => prepareLocalWorktrees(request),
    );
    try {
      const runStage = (stage, options, priority) => {
        if (!scheduleWork) {
          if (stage === REVIEW_WORK_STAGES.REVIEW) return runReview(options);
          if (stage === REVIEW_WORK_STAGES.TEST) return runTests(options);
          if (stage === REVIEW_WORK_STAGES.ANALYZE) return analyze(options);
          if (stage === REVIEW_WORK_STAGES.INITIAL_ANALYZE) return initialAnalyze(options);
          if (stage === REVIEW_WORK_STAGES.SECURITY) return runSecurity(options);
          throw new Error(`Unsupported review stage '${stage}'.`);
        }
        return scheduleWork({
          stage,
          repository: request.repository,
          number: request.number,
          localPrId: request.localPrId,
          options,
        }, { priority, reviewLane: request.reviewLane });
      };
      // This binding is intentionally per PR. A pool task must always carry
      // the local PR identity that owns it, never an ambient mutable request.
      const executeReview = (options) => runStage(REVIEW_WORK_STAGES.REVIEW, options, 0);
      const executeTests = (options) => runStage(REVIEW_WORK_STAGES.TEST, options, 1);
      const executeAnalysis = (options) => runStage(REVIEW_WORK_STAGES.ANALYZE, options, 1);
      const executeInitialAnalysis = (options) =>
        runStage(REVIEW_WORK_STAGES.INITIAL_ANALYZE, options, 1);
      const executeSecurity = (options) => runStage(REVIEW_WORK_STAGES.SECURITY, options, 2);
      const reviewWithFallback = (options) =>
        runReviewWithCapacityFallback(options, executeReview);
      // The plan is decided from the submitted diff, before any expensive stage
      // runs, so the change profile is the first thing this review establishes.
      let submitted = await readChangeProfile(worktrees.head, worktrees.mergeBase);
      let docsOnly = submitted.classification.docsOnly;
      let docsOrConfigOnly = submitted.classification.docsOrConfigOnly;
      let codeDomainRequired = submitted.classification.codeDomainRequired;
      assertMeaningfulReviewDiff(submitted);
      if (request.reviewMode === "verification") {
        const partialAnatomiaCliPath = request.verificationTargets?.includes("anatomia")
          ? await resolveAnatomiaCli(settings.anatomiaFolder)
          : null;
        // Await inside the try block so finally cannot remove the disposable
        // worktrees while partial verification is still using them.
        return await runPartialVerification({
          request,
          submitted,
          settings,
          worktrees,
          anatomiaCliPath: partialAnatomiaCliPath,
          env,
          runSecurity: executeSecurity,
          complexityDropThreshold,
          analyze: executeAnalysis,
          runTests: executeTests,
        });
      }
      let initialLeakage = scanAddedDiffForLeaks(submitted.unifiedDiff);
      const deterministicPlan = planReview({
        classification: submitted.classification,
        testCases: request.testCases,
      });
      const frontGatePlan = applyCostValidationMode(deterministicPlan, settings);
      // This is deliberately before plan advice and every reviewer invocation:
      // deterministic Anatomia violations must not consume an LLM review slot.
      let anatomiaGate = await runAnatomiaReviewGate({
        enabled: settings.anatomiaReviewGateEnabled,
        resolveCli: resolveAnatomiaCli,
        analyze: executeAnalysis,
        anatomiaFolder: settings.anatomiaFolder,
        cwd: worktrees.head,
        base: worktrees.mergeBase,
        plan: frontGatePlan,
        classification: submitted.classification,
      });
      if (anatomiaGate.status === "blocked") {
        return buildAnatomiaBlockedResult({
          request,
          gate: anatomiaGate,
          complexityDropThreshold,
          initialLeakage,
          docsOnly,
          docsOrConfigOnly,
          plan: frontGatePlan,
          classification: submitted.classification,
        });
      }
      const concordiaUrl = optionalConcordiaUrl(cwd, settings.concordiaContextEnabled);
      const authorContext = await resolveAuthorContext({
        settings,
        concordiaUrl,
        request,
        workspaceRoot,
        env,
        transport,
      });
      let externalReviewer = reviewerForProvider(
        authorContext?.provider,
        settings.fallbackReviewer,
      );
      let plan = await advisePlan({
        // The default is deterministic. An explicitly configured advisor is a
        // separate, visible model cost and remains subject to the plan floor.
        advisor: settings.costValidationSkipReview ? "none" : settings.planAdvisor,
        plan: deterministicPlan,
        request,
        testCases: request.testCases,
        cwd: worktrees.head,
        augurFolder: settings.augurFolder,
        reviewer: externalReviewer,
        runReview: executeReview,
        leakageClear: initialLeakage.totalFindings === 0,
      });
      plan = applyCostValidationMode(plan, settings);
      codeDomainRequired = submitted.classification.codeDomainRequired
        && stageEnabled(plan, "anatomia_domain_review");
      const codeAnalysis = stageEnabled(plan, "anatomia_code_analysis");
      const anatomiaUnavailable = anatomiaGate.status === "unavailable";
      const anatomiaCliPath = anatomiaUnavailable
        ? null
        : (anatomiaGate.cliPath ?? await resolveAnatomiaCli(settings.anatomiaFolder));
      let [initial, { firstAnalysis, baseline }] = await Promise.all([
        anatomiaGate.analysis
          ? Promise.resolve(anatomiaGate.analysis)
          : executeAnalysis({
              cliPath: anatomiaCliPath,
              cwd: worktrees.head,
              base: worktrees.mergeBase,
            }),
        anatomiaUnavailable
          ? Promise.resolve({ firstAnalysis: null, baseline: null })
          : analyzeCodeBaseline({
              cliPath: anatomiaCliPath,
              repoPath,
              repository: request.repository,
              worktrees,
              enabled: codeAnalysis,
              analyze: executeAnalysis,
              initialAnalyze: executeInitialAnalysis,
            }),
      ]);
      let reviewStrategy = selectReviewStrategy({
        classification: submitted.classification,
        unifiedDiff: submitted.unifiedDiff,
        analysis: initial,
        settings,
      });
      plan = { ...plan, reviewStrategy };
      let initialCi = await executeTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        plan,
        env,
      });
      let initialSecurity = await reviewSecurityScan({
        runSecurity: executeSecurity,
        worktrees,
        leakage: initialLeakage,
        ci: initialCi,
        settings,
        plan,
      });
      let gateInput = {
        request,
        firstAnalysis,
        baseline,
        complexityDropThreshold,
        initialLeakage,
        plan,
        classification: submitted.classification,
        security: initialSecurity,
        anatomiaGate,
        analysisSource: anatomiaUnavailable ? "anatomia-unavailable" : "anatomia-cli",
      };
      if (initialLeakage.totalFindings > 0) {
        return {
          ...buildGateResult({
            ...gateInput,
            finalAnalysis: initial,
            reviewer: null,
            contextSource: authorContext?.source ?? "leakage-blocked",
            reviewedHeadSha: request.headSha,
            leakage: initialLeakage,
            ci: initialCi,
            docsOnly,
            docsOrConfigOnly,
            security: initialSecurity,
          }),
          humanQuestion: "Potential information leakage must be removed before automated review.",
        };
      }
      if (!testsPassed(initialCi)) {
        // Validation mode promises that no review model is invoked. A failing
        // registered test remains blocking evidence instead of entering the
        // model-backed repair loop.
        if (!isTestAutofixEnabled(plan)) {
          return {
            ...buildGateResult({
              ...gateInput,
              finalAnalysis: initial,
              reviewer: "skipped",
              contextSource: "cost-validation-mode",
              reviewedHeadSha: request.headSha,
              leakage: initialLeakage,
              ci: initialCi,
              docsOnly,
              docsOrConfigOnly,
              security: initialSecurity,
              intentReviewCompleted: true,
            }),
            humanQuestion: "Registered tests must pass before validation can continue.",
          };
        }
        const autofix = await autofixFailingTests({
          request,
          reviewer: externalReviewer,
          worktreePath: worktrees.head,
          mergeBase: worktrees.mergeBase,
          initialCi,
          testCases: request.testCases,
          plan,
          env,
          runReview: executeReview,
          runTests: executeTests,
          reviewerTimeoutMs,
        });
        externalReviewer = autofix.reviewer;
        initialCi = autofix.ci;
        if (!testsPassed(initialCi)) {
          return {
            ...buildGateResult({
              ...gateInput,
              finalAnalysis: initial,
              reviewer: externalReviewer,
              contextSource: "registered-test-autofix",
              reviewedHeadSha: request.headSha,
              leakage: initialLeakage,
              ci: initialCi,
              docsOnly,
              docsOrConfigOnly,
              security: initialSecurity,
            }),
            humanQuestion: testAutofixHumanQuestion(autofix.status),
          };
        }
        // Test repair happens before the single intent review. Refresh the
        // deterministic evidence now; no reviewer has run yet.
        const preAutofixClassification = submitted.classification;
        submitted = await readChangeProfile(worktrees.head, worktrees.mergeBase);
        docsOnly = submitted.classification.docsOnly;
        docsOrConfigOnly = submitted.classification.docsOrConfigOnly;
        const reviewPlanChanged = changeKindsDiffer(
          preAutofixClassification,
          submitted.classification,
        );
        if (reviewPlanChanged) {
          plan = applyCostValidationMode(planReview({
            classification: submitted.classification,
            testCases: request.testCases,
          }), settings);
          initialCi = await verifyAutofixPlan({
            worktreePath: worktrees.head,
            testCases: request.testCases,
            plan,
            env,
            runTests: executeTests,
          });
        }
        codeDomainRequired = submitted.classification.codeDomainRequired
          && stageEnabled(plan, "anatomia_domain_review");
        initialLeakage = scanAddedDiffForLeaks(submitted.unifiedDiff);
        if (!anatomiaUnavailable) {
          initial = await executeAnalysis({
            cliPath: anatomiaCliPath,
            cwd: worktrees.head,
            base: worktrees.mergeBase,
          });
          if (settings.anatomiaReviewGateEnabled) {
            anatomiaGate = evaluateAnatomiaReviewGate({
              analysis: initial,
              cliPath: anatomiaCliPath,
              plan,
              classification: submitted.classification,
            });
            if (anatomiaGate.status === "blocked") {
              return buildAnatomiaBlockedResult({
                request,
                gate: anatomiaGate,
                complexityDropThreshold,
                initialLeakage,
                leakage: initialLeakage,
                ci: initialCi,
                docsOnly,
                docsOrConfigOnly,
                plan,
                classification: submitted.classification,
                reviewer: externalReviewer,
                contextSource: "anatomia-review-gate-after-test-autofix",
              });
            }
          }
        }
        reviewStrategy = selectReviewStrategy({
          classification: submitted.classification,
          unifiedDiff: submitted.unifiedDiff,
          analysis: initial,
          settings,
        });
        plan = { ...plan, reviewStrategy };
        initialSecurity = await reviewSecurityScan({
          runSecurity: executeSecurity,
          worktrees,
          leakage: initialLeakage,
          ci: initialCi,
          settings,
          plan,
        });
        gateInput = {
          ...gateInput,
          initialLeakage,
          plan,
          classification: submitted.classification,
          security: initialSecurity,
          anatomiaGate,
        };
      }
      if (!stageEnabled(plan, "reviewer_autofix")) {
        const reviewed = await readChangeProfile(worktrees.head, worktrees.mergeBase);
        const finalLeakage = scanAddedDiffForLeaks(reviewed.unifiedDiff);
        if (finalLeakage.totalFindings > 0) {
          throw new Error(
            "Test autofix introduced potential information leakage; changes were discarded before commit or push.",
          );
        }
        const reviewedHeadSha = await commitAndAdvanceAutofix(
          worktrees.head,
          repoPath,
          request,
        );
        return {
          ...buildGateResult({
            ...gateInput,
            finalAnalysis: initial,
            reviewer: "skipped",
            contextSource: "cost-validation-mode",
            reviewedHeadSha,
            leakage: finalLeakage,
            ci: initialCi,
            docsOnly,
            docsOrConfigOnly,
            plan,
            classification: reviewed.classification,
            security: initialSecurity,
            intentReviewCompleted: true,
          }),
          humanQuestion: null,
        };
      }
      reviewTier(plan);
      let reviewer = externalReviewer;
      let investigation = null;
      if (reviewStrategy.mode === "multi-agent") {
        investigation = await reviewWithFallback({
          reviewer,
          cwd: worktrees.head,
          prompt: investigationPrompt({
            request,
            analysis: initial,
            unifiedDiff: submitted.unifiedDiff,
          }),
          timeoutMs: reviewerTimeoutMs,
          readOnly: true,
          ...reviewStrategy.investigator,
        });
        reviewer = investigation.reviewer;
        if (!investigation.ok) {
          throw new Error(
            "Review investigation failed; output was withheld from the Check Run.",
          );
        }
      }
      const baseReviewPrompt = buildReviewerPrompt({
        request,
        analysis: initial,
        authorContext,
        unifiedDiff: submitted.unifiedDiff.slice(0, 120_000),
        leakage: initialLeakage,
        docsOnly,
        docsOrConfigOnly,
        codeDomainRequired,
        plan,
      });
      const reviewResult = await reviewWithFallback({
        reviewer,
        cwd: worktrees.head,
        prompt: investigation?.ok
          ? `${baseReviewPrompt}\n\nIndependent investigation findings:\n${investigation.stdout.slice(0, 40_000)}`
          : baseReviewPrompt,
        timeoutMs: reviewerTimeoutMs,
        ...reviewStrategy.judge,
      });
      reviewer = reviewResult.reviewer;
      if (!reviewResult.ok) {
        throw new Error("Opposite-model reviewer failed; output was withheld from the Check Run.");
      }
      // Persist the checkpoint before the remaining stages run. Everything after
      // this point is cheap to repeat; this is not. Recording it here is what
      // lets an interrupted review resume in verification mode instead of
      // paying for the model review again after every restart.
      await reportIntentReviewCompleted(onIntentReviewCompleted, {
        localPrId: request.localPrId,
        jobId: request.jobId,
        reviewedHeadSha: request.headSha,
        reviewer,
        plan,
      });
      // The expensive intent review is deliberately single-shot. Failing tests
      // enter the narrow autofix loop and never trigger another general review.
      // Anatomia is rerun once after all edits, below, so the final domain and
      // architecture evidence still describes the bytes that are committed.
      let finalAnalysis = initial;
      let reviewed = await readChangeProfile(worktrees.head, worktrees.mergeBase);
      // The relaxation and the risk profile must follow the reviewed diff, not the
      // submitted one: an autofix that touches code makes the change no longer
      // docs/config-only, and the missing target domain has to block again.
      let finalDocsOnly = reviewed.classification.docsOnly;
      let finalDocsOrConfigOnly = reviewed.classification.docsOrConfigOnly;
      let finalCodeDomainRequired = reviewed.classification.codeDomainRequired;
      // For the same reason the plan itself has to follow the reviewed diff. A
      // plan made for a documentation edit switched the registered tests and the
      // code-analysis gating off; if the autofix introduced executable content,
      // that plan no longer describes what is about to be merged, so everything
      // decided from here on re-plans deterministically from the reviewed change.
      // An advised plan is discarded here on purpose: the advisor answered a
      // question about a change that no longer exists.
      let finalPlan = changeKindsDiffer(
        submitted.classification,
        reviewed.classification,
      )
        ? applyCostValidationMode(planReview({
            classification: reviewed.classification,
            testCases: request.testCases,
          }), settings)
        : plan;
      finalPlan = { ...finalPlan, reviewStrategy };
      // The scan still runs at most once per review pass — the pre-merge scan
      // covers whatever the reviewer added. But once the re-plan asks for the
      // vulnerability stage, the recorded outcome must stop claiming the plan
      // never wanted it, or the board reports a reason that is no longer true.
      let finalSecurity = initialSecurity.status === "skipped"
        && !stageEnabled(plan, "security_review")
        && stageEnabled(finalPlan, "security_review")
        ? skippedSecurityScan(
            "required only after the reviewer added executable content; covered by the pre-merge scan",
          )
        : initialSecurity;
      let finalCi = await executeTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        plan: finalPlan,
        env,
      });
      if (!testsPassed(finalCi)) {
        const autofix = await autofixFailingTests({
          request,
          reviewer,
          worktreePath: worktrees.head,
          mergeBase: worktrees.mergeBase,
          initialCi: finalCi,
          testCases: request.testCases,
          plan: finalPlan,
          env,
          runReview: executeReview,
          runTests: executeTests,
          reviewerTimeoutMs,
        });
        reviewer = autofix.reviewer;
        finalCi = autofix.ci;
        if (!testsPassed(finalCi)) {
          return {
            ...buildGateResult({
              ...gateInput,
              finalAnalysis,
              reviewer,
              contextSource: authorContext?.source ?? "pr-only",
              reviewedHeadSha: request.headSha,
              reviewerOutput: reviewResult.stdout,
              leakage: initialLeakage,
              ci: finalCi,
              docsOnly,
              docsOrConfigOnly,
              plan: finalPlan,
              security: finalSecurity,
              // The reviewed/autofixed worktree is discarded on this path.
              // A later retry must not treat its judgment as evidence for the
              // unchanged submitted head.
              intentReviewCompleted: false,
            }),
            humanQuestion: testAutofixHumanQuestion(autofix.status),
          };
        }
        reviewed = await readChangeProfile(worktrees.head, worktrees.mergeBase);
        finalDocsOnly = reviewed.classification.docsOnly;
        finalDocsOrConfigOnly = reviewed.classification.docsOrConfigOnly;
        finalCodeDomainRequired = reviewed.classification.codeDomainRequired;
        const reviewPlanChanged = changeKindsDiffer(
          submitted.classification,
          reviewed.classification,
        );
        finalPlan = reviewPlanChanged
          ? applyCostValidationMode(planReview({
              classification: reviewed.classification,
              testCases: request.testCases,
            }), settings)
          : plan;
        finalPlan = { ...finalPlan, reviewStrategy };
        if (reviewPlanChanged) {
          finalCi = await verifyAutofixPlan({
            worktreePath: worktrees.head,
            testCases: request.testCases,
            plan: finalPlan,
            env,
            runTests: executeTests,
          });
          if (finalSecurity.status === "skipped"
              && stageEnabled(finalPlan, "security_review")) {
            finalSecurity = skippedSecurityScan(
              "required only after autofix added executable content; covered by the pre-merge scan",
            );
          }
        }
      }
      const finalLeakage = scanAddedDiffForLeaks(reviewed.unifiedDiff);
      if (finalLeakage.totalFindings > 0) {
        throw new Error(
          "Opposite-model autofix introduced potential information leakage; changes were discarded before commit or push.",
        );
      }
      if (!anatomiaUnavailable) {
        finalAnalysis = await executeAnalysis({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        });
      }
      const reviewedHeadSha = await commitAndAdvanceAutofix(
        worktrees.head,
        repoPath,
        request,
      );
      const needsHuman = needsTargetDomain(
        finalAnalysis,
        finalDocsOrConfigOnly,
        finalCodeDomainRequired,
        stageEnabled(finalPlan, "anatomia_domain_review"),
      )
        || reviewResult.stdout.includes("PR_GATE_NEEDS_HUMAN");
      return {
        ...buildGateResult({
          ...gateInput,
          finalAnalysis,
          reviewer,
          contextSource: authorContext?.source ?? "pr-only",
          reviewedHeadSha,
          reviewerOutput: reviewResult.stdout,
          leakage: finalLeakage,
          ci: finalCi,
          docsOnly: finalDocsOnly,
          docsOrConfigOnly: finalDocsOrConfigOnly,
          plan: finalPlan,
          classification: reviewed.classification,
          security: finalSecurity,
          intentReviewCompleted: true,
        }),
        humanQuestion: needsHuman
          ? targetDomainQuestion(request.repository, request.number)
          : null,
      };
    } finally {
      await mutateWorktrees(repoPath, () => cleanupWorktrees(repoPath, worktrees));
    }
  };
}

async function resolveAuthorContext({
  settings,
  concordiaUrl,
  request,
  workspaceRoot,
  env,
  transport,
}) {
  const httpContext = await loadConcordiaContext({
    baseUrl: concordiaUrl,
    repository: request.repository,
    headRef: request.headRef,
    transport,
  });
  if (httpContext) return httpContext;
  if (!settings.concordiaContextEnabled) return null;
  return loadPersistedConcordiaContext({
    workspaceRoot,
    repository: request.repository,
    headRef: request.headRef,
    dbPath: env.CONCORDIA_DB_PATH,
  });
}
