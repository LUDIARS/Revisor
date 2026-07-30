import { analyzePr, ensureInitialAnalysis, resolveAnatomiaCli } from "./anatomia.mjs";
import { resolveServiceLoopbackUrl, resolveWorkspaceRoot } from "./catalog.mjs";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
  notifyConcordia,
  targetDomainQuestion,
} from "./concordia-context.mjs";
import { readSettings } from "./config.mjs";
import { runPlannedTests, testsPassed } from "./ci.mjs";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { assessMergeRisk, assessRuntimeVerification } from "./merge-risk.mjs";
import { advisePlan } from "./plan-advisor.mjs";
import { runSecurityScan, skippedSecurityScan } from "./security-scan.mjs";
import { reviewerForProvider, runReviewer } from "./reviewer.mjs";
import { buildReviewerPrompt } from "./reviewer-prompt.mjs";
import { gateOutcome, needsTargetDomain } from "./review-gate.mjs";
import { readChangeProfile } from "./review-diff.mjs";
import {
  codeAnalysisGating,
  hasExecutableChange,
  planReview,
  stageEnabled,
} from "./review-plan.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  git,
  prepareLocalWorktrees,
} from "./workspace.mjs";

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

function optionalConcordiaUrl(cwd, enabled) {
  if (!enabled) return null;
  try {
    return resolveServiceLoopbackUrl(cwd, "concordia");
  } catch {
    return null;
  }
}

// The baseline analysis exists only to produce a complexity delta, and the
// project-wide initial analysis only to report what the repository looks like. A
// plan that drops code analysis drops both runs, which is where most of the saved
// time comes from.
async function analyzeCodeBaseline({ cliPath, repoPath, repository, worktrees, enabled }) {
  if (!enabled) return { firstAnalysis: null, baseline: null };
  const [firstAnalysis, baseline] = await Promise.all([
    ensureInitialAnalysis({ cliPath, repoPath, repository }),
    analyzePr({ cliPath, cwd: worktrees.base, base: "HEAD" }),
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
  plan,
  classification,
  security,
}) {
  const complexityScoreDelta = baseline
    ? finalAnalysis.quality.complexity.score - baseline.quality.complexity.score
    : null;
  const { reasons, advisories } = gateOutcome({
    finalAnalysis,
    complexityScoreDelta,
    threshold: complexityDropThreshold,
    reviewerOutput,
    leakage,
    ci,
    docsOnly,
    plan,
    security,
  });
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
    contextSource,
    analysisSource: "anatomia-cli",
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
    complexityScoreDelta,
    initialLeakage,
    leakage,
    ci,
    security,
    reasons,
    advisories,
    runtimeVerification,
    mergeRisk,
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

export function createPrReviewRunner({
  cwd,
  env = process.env,
  reviewerTimeoutMs = 30 * 60_000,
  complexityDropThreshold = 10,
  runReview = runReviewer,
  runSecurity = runSecurityScan,
  transport = fetch,
} = {}) {
  return async (request) => {
    if (request.repository !== request.headRepository) {
      throw new Error("Fork pull requests are not eligible for the local autofix review");
    }
    const settings = readSettings(env);
    const anatomiaCliPath = await resolveAnatomiaCli(settings.anatomiaFolder);
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const repoPath = request.rootPath;
    const worktrees = await prepareLocalWorktrees(repoPath, request);
    try {
      // The plan is decided from the submitted diff, before any expensive stage
      // runs, so the change profile is the first thing this review establishes.
      const submitted = await readChangeProfile(worktrees.head, worktrees.mergeBase);
      const docsOnly = submitted.classification.docsOnly;
      const initialLeakage = scanAddedDiffForLeaks(submitted.unifiedDiff);
      const concordiaUrl = optionalConcordiaUrl(cwd, settings.concordiaContextEnabled);
      const authorContext = request.reviewMode === "verification"
        ? null
        : await resolveAuthorContext({
            settings,
            concordiaUrl,
            request,
            workspaceRoot,
            env,
            transport,
          });
      const reviewer = reviewerForProvider(authorContext?.provider, settings.fallbackReviewer);
      const plan = await advisePlan({
        // Verification-only runs invoke no model at all, so they stay on the
        // deterministic plan.
        advisor: request.reviewMode === "verification" ? "none" : settings.planAdvisor,
        plan: planReview({
          classification: submitted.classification,
          testCases: request.testCases,
        }),
        request,
        testCases: request.testCases,
        cwd: worktrees.head,
        augurFolder: settings.augurFolder,
        reviewer,
        runReview,
        leakageClear: initialLeakage.totalFindings === 0,
      });
      const codeAnalysis = stageEnabled(plan, "anatomia_code_analysis");
      const [initial, { firstAnalysis, baseline }] = await Promise.all([
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        }),
        analyzeCodeBaseline({
          cliPath: anatomiaCliPath,
          repoPath,
          repository: request.repository,
          worktrees,
          enabled: codeAnalysis,
        }),
      ]);
      const initialCi = await runPlannedTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        plan,
        env,
      });
      const initialSecurity = await reviewSecurityScan({
        runSecurity,
        worktrees,
        leakage: initialLeakage,
        ci: initialCi,
        settings,
        plan,
      });
      const gateInput = {
        request,
        firstAnalysis,
        baseline,
        complexityDropThreshold,
        initialLeakage,
        plan,
        classification: submitted.classification,
        security: initialSecurity,
      };
      if (request.reviewMode === "verification") {
        return {
          ...buildGateResult({
            ...gateInput,
            finalAnalysis: initial,
            reviewer: null,
            contextSource: "verification-only",
            reviewedHeadSha: request.headSha,
            leakage: initialLeakage,
            ci: initialCi,
            docsOnly,
            security: initialSecurity,
          }),
          humanQuestion: needsTargetDomain(initial, docsOnly)
            ? targetDomainQuestion(request.repository, request.number)
            : null,
        };
      }
      if (!testsPassed(initialCi)) {
        return {
          ...buildGateResult({
            ...gateInput,
            finalAnalysis: initial,
            reviewer: null,
            contextSource: "registered-tests",
            reviewedHeadSha: request.headSha,
            leakage: initialLeakage,
            ci: initialCi,
            docsOnly,
            security: initialSecurity,
          }),
          humanQuestion: "Registered tests must pass before automated review.",
        };
      }
      if (initialLeakage.totalFindings > 0) {
        await notifyConcordia({
          baseUrl: concordiaUrl,
          sessionId: authorContext?.sessionId,
          text: `PRレビュー: ${request.repository}#${request.number} に情報流出の可能性がある追加箇所を ${initialLeakage.totalFindings} 件検出しました。外部レビュアーへ差分を送らず、人間の修正を待ちます。`,
          transport,
        });
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
            security: initialSecurity,
          }),
          humanQuestion: "Potential information leakage must be removed before automated review.",
        };
      }
      if (needsTargetDomain(initial, docsOnly)) {
        await notifyConcordia({
          baseUrl: concordiaUrl,
          sessionId: authorContext?.sessionId,
          text: `PRレビュー: ${request.repository}#${request.number} の差分に対象ドメインがありません。元の依頼文から spec/domain 定義の自動補完を試みます。`,
          transport,
        });
      }
      const reviewResult = await runReview({
        reviewer,
        cwd: worktrees.head,
        prompt: buildReviewerPrompt({
          request,
          analysis: initial,
          authorContext,
          unifiedDiff: submitted.unifiedDiff.slice(0, 120_000),
          leakage: initialLeakage,
          docsOnly,
          plan,
        }),
        timeoutMs: reviewerTimeoutMs,
      });
      if (!reviewResult.ok) {
        throw new Error("Opposite-model reviewer failed; output was withheld from the Check Run.");
      }
      const [finalAnalysis, reviewed] = await Promise.all([
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        }),
        readChangeProfile(worktrees.head, worktrees.mergeBase),
      ]);
      // The relaxation and the risk profile must follow the reviewed diff, not the
      // submitted one: an autofix that touches code makes the change no longer
      // docs-only, and the missing target domain has to block again.
      const finalDocsOnly = reviewed.classification.docsOnly;
      // For the same reason the plan itself has to follow the reviewed diff. A
      // plan made for a documentation edit switched the registered tests and the
      // code-analysis gating off; if the autofix introduced executable content,
      // that plan no longer describes what is about to be merged, so everything
      // decided from here on re-plans deterministically from the reviewed change.
      // An advised plan is discarded here on purpose: the advisor answered a
      // question about a change that no longer exists.
      const finalPlan = hasExecutableChange(reviewed.classification)
        && !hasExecutableChange(submitted.classification)
        ? planReview({
            classification: reviewed.classification,
            testCases: request.testCases,
          })
        : plan;
      // The scan still runs at most once per review pass — the pre-merge scan
      // covers whatever the reviewer added. But once the re-plan asks for the
      // vulnerability stage, the recorded outcome must stop claiming the plan
      // never wanted it, or the board reports a reason that is no longer true.
      const finalSecurity = initialSecurity.status === "skipped"
        && !stageEnabled(plan, "security_review")
        && stageEnabled(finalPlan, "security_review")
        ? skippedSecurityScan(
            "required only after the reviewer added executable content; covered by the pre-merge scan",
          )
        : initialSecurity;
      const finalLeakage = scanAddedDiffForLeaks(reviewed.unifiedDiff);
      if (finalLeakage.totalFindings > 0) {
        throw new Error(
          "Opposite-model autofix introduced potential information leakage; changes were discarded before commit or push.",
        );
      }
      const finalCi = await runPlannedTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        plan: finalPlan,
        env,
      });
      if (!testsPassed(finalCi)) {
        return {
          ...buildGateResult({
            ...gateInput,
            finalAnalysis: initial,
            reviewer,
            contextSource: authorContext?.source ?? "pr-only",
            reviewedHeadSha: request.headSha,
            reviewerOutput: reviewResult.stdout,
            leakage: initialLeakage,
            ci: finalCi,
            docsOnly,
            plan: finalPlan,
            security: finalSecurity,
          }),
          humanQuestion: "Reviewer changes were discarded because registered tests failed.",
        };
      }
      const reviewedHeadSha = await commitAndAdvanceAutofix(
        worktrees.head,
        repoPath,
        request,
      );
      const needsHuman = needsTargetDomain(finalAnalysis, finalDocsOnly)
        || reviewResult.stdout.includes("PR_GATE_NEEDS_HUMAN");
      await notifyConcordia({
        baseUrl: concordiaUrl,
        sessionId: authorContext?.sessionId,
        text: needsHuman
          ? targetDomainQuestion(request.repository, request.number)
          : `PRレビュー: ${request.repository}#${request.number} の相互モデルレビューと Anatomia 再解析が完了しました。`,
        transport,
      });
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
          plan: finalPlan,
          classification: reviewed.classification,
          security: finalSecurity,
        }),
        humanQuestion: needsHuman
          ? targetDomainQuestion(request.repository, request.number)
          : null,
      };
    } finally {
      await cleanupWorktrees(repoPath, worktrees);
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
