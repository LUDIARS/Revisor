import { analyzePr, ensureInitialAnalysis, resolveAnatomiaCli } from "./anatomia.mjs";
import { resolveServiceLoopbackUrl, resolveWorkspaceRoot } from "./catalog.mjs";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
  notifyConcordia,
  targetDomainQuestion,
} from "./concordia-context.mjs";
import { readSettings } from "./config.mjs";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { reviewerForProvider, runReviewer } from "./reviewer.mjs";
import {
  cleanupWorktrees,
  git,
  prepareWorktrees,
  resolveRepositoryPath,
} from "./workspace.mjs";

function buildReviewerPrompt({
  request,
  analysis,
  authorContext,
  unifiedDiff,
  leakage,
}) {
  const needsDomain = !analysis.domain.hasTargetDomain;
  return [
    `Review and autofix PR ${request.repository}#${request.number}.`,
    `Compare the checked-out HEAD with ${request.baseRef}.`,
    "You may read and edit files only. Do not run repository code, install dependencies, use network access, commit, or push; Revisor owns Git operations and GitHub CI owns execution.",
    "Perform a normal correctness, security, and maintainability review and directly fix actionable issues.",
    "Explicitly check for information leakage: credentials, personal data, private endpoints, session transcripts, logs, local configuration, and proprietary artifacts that should not enter the repository.",
    `Local high-confidence leakage scan (contains locations only, never matched values):\n${JSON.stringify(leakage, null, 2)}`,
    "Preserve existing user changes and keep edits scoped to this PR.",
    `Anatomia temporary analysis (may be truncated):\n${JSON.stringify(analysis, null, 2).slice(0, 80_000)}`,
    `Unified PR diff (may be truncated):\n${unifiedDiff}`,
    needsDomain
      ? [
          "Anatomia found no target domain for the changed functions.",
          "Infer the target domain from the PR diff and optional original-session context.",
          "Add or update both an AIFormat-compatible spec and the minimal .anatomia/domains membership definition so the changed functions are attributable.",
          "Do not invent a domain if the context is insufficient; include PR_GATE_NEEDS_HUMAN in your final response.",
        ].join(" ")
      : "Ensure the existing target-domain and spec traceability remains accurate.",
    "Resolve newly orphaned functions and avoid a material complexity-score regression where practical.",
    `Original author provider: ${authorContext?.provider ?? "(unavailable; configured fallback reviewer is in use)"}`,
    `Original session context:\n${authorContext?.text || "(Concordia unavailable or no matching session; review from PR evidence only)"}`,
  ].join("\n\n");
}

async function commitAndPushAutofix(cwd, request) {
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status) {
    await git(cwd, ["add", "--all"]);
    await git(cwd, [
      "commit",
      "-m",
      "fix(pr-review): apply automated review fixes",
      "-m",
      "Revisor-Autofix: true",
    ]);
  }
  const reviewedHead = await git(cwd, ["rev-parse", "HEAD"]);
  if (reviewedHead.toLowerCase() !== request.headSha.toLowerCase()) {
    await git(cwd, ["push", "origin", `HEAD:refs/heads/${request.headRef}`]);
  }
  return reviewedHead;
}

function gateReasons(
  finalAnalysis,
  complexityScoreDelta,
  threshold,
  reviewerOutput,
  leakage,
) {
  const reasons = [];
  if (!finalAnalysis.domain.hasTargetDomain) reasons.push("target domain is still missing");
  if (finalAnalysis.quality.changedOrphans.length > 0) {
    reasons.push(`${finalAnalysis.quality.changedOrphans.length} changed function(s) are orphaned`);
  }
  if (finalAnalysis.architecture.verify && !finalAnalysis.architecture.verify.pass) {
    reasons.push("Anatomia five-gate verification did not pass");
  }
  const blockingViolations = finalAnalysis.architecture.changedViolations
    .filter((violation) => violation.severity === "error");
  if (blockingViolations.length > 0) {
    reasons.push(`${blockingViolations.length} changed architecture rule violation(s) remain`);
  }
  if (complexityScoreDelta <= -threshold) {
    reasons.push(`complexity score dropped by ${Math.abs(complexityScoreDelta)} points`);
  }
  if (reviewerOutput.includes("PR_GATE_NEEDS_HUMAN")) {
    reasons.push("reviewer reported insufficient information for a safe domain/spec definition");
  }
  if (leakage.totalFindings > 0) {
    reasons.push(`${leakage.totalFindings} potential information leakage finding(s) remain`);
  }
  return reasons;
}

function optionalConcordiaUrl(cwd, enabled) {
  if (!enabled) return null;
  try {
    return resolveServiceLoopbackUrl(cwd, "concordia");
  } catch {
    return null;
  }
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
}) {
  const complexityScoreDelta =
    finalAnalysis.quality.complexity.score - baseline.quality.complexity.score;
  const reasons = gateReasons(
    finalAnalysis,
    complexityScoreDelta,
    complexityDropThreshold,
    reviewerOutput,
    leakage,
  );
  return {
    conclusion: reasons.length === 0 ? "success" : "action_required",
    reviewMode: request.reviewMode,
    reviewer,
    contextSource,
    analysisSource: "anatomia-cli",
    originalHeadSha: request.headSha,
    reviewedHeadSha,
    initialAnalysis: {
      project: firstAnalysis.project.id,
      files: firstAnalysis.analysis.files,
      functions: firstAnalysis.analysis.functions,
      cacheHit: firstAnalysis.analysis.cacheHit,
    },
    analysis: finalAnalysis,
    baselineComplexityScore: baseline.quality.complexity.score,
    complexityScoreDelta,
    initialLeakage,
    leakage,
    reasons,
  };
}

async function readUnifiedDiff(cwd, mergeBase) {
  return git(cwd, [
    "diff",
    "--no-ext-diff",
    mergeBase,
    "--",
  ]);
}

export function createPrReviewRunner({
  cwd,
  env = process.env,
  reviewerTimeoutMs = 30 * 60_000,
  complexityDropThreshold = 10,
  runReview = runReviewer,
  transport = fetch,
} = {}) {
  return async (request) => {
    if (request.repository !== request.headRepository) {
      throw new Error("Fork pull requests are not eligible for the local autofix review");
    }
    const settings = readSettings(env);
    const anatomiaCliPath = await resolveAnatomiaCli(settings.anatomiaFolder);
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const repoPath = await resolveRepositoryPath(cwd, request.repository);
    const firstAnalysis = await ensureInitialAnalysis({
      cliPath: anatomiaCliPath,
      repoPath,
      repository: request.repository,
    });
    const worktrees = await prepareWorktrees(repoPath, request);
    try {
      const [initial, baseline] = await Promise.all([
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        }),
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.base,
          base: "HEAD",
        }),
      ]);
      const initialUnifiedDiff = await readUnifiedDiff(worktrees.head, worktrees.mergeBase);
      const initialLeakage = scanAddedDiffForLeaks(initialUnifiedDiff);
      if (request.reviewMode === "verification") {
        return {
          ...buildGateResult({
            request,
            firstAnalysis,
            finalAnalysis: initial,
            baseline,
            reviewer: null,
            contextSource: "verification-only",
            reviewedHeadSha: request.headSha,
            complexityDropThreshold,
            initialLeakage,
            leakage: initialLeakage,
          }),
          humanQuestion: !initial.domain.hasTargetDomain
            ? targetDomainQuestion(request.repository, request.number)
            : null,
        };
      }
      const concordiaUrl = optionalConcordiaUrl(cwd, settings.concordiaContextEnabled);
      const httpContext = await loadConcordiaContext({
        baseUrl: concordiaUrl,
        repository: request.repository,
        headRef: request.headRef,
        transport,
      });
      const authorContext = httpContext ?? (
        settings.concordiaContextEnabled
          ? await loadPersistedConcordiaContext({
              workspaceRoot,
              repository: request.repository,
              headRef: request.headRef,
              dbPath: env.CONCORDIA_DB_PATH,
            })
          : null
      );
      if (initialLeakage.totalFindings > 0) {
        await notifyConcordia({
          baseUrl: concordiaUrl,
          sessionId: authorContext?.sessionId,
          text: `PRレビュー: ${request.repository}#${request.number} に情報流出の可能性がある追加箇所を ${initialLeakage.totalFindings} 件検出しました。外部レビュアーへ差分を送らず、人間の修正を待ちます。`,
          transport,
        });
        return {
          ...buildGateResult({
            request,
            firstAnalysis,
            finalAnalysis: initial,
            baseline,
            reviewer: null,
            contextSource: authorContext?.source ?? "leakage-blocked",
            reviewedHeadSha: request.headSha,
            complexityDropThreshold,
            initialLeakage,
            leakage: initialLeakage,
          }),
          humanQuestion: "Potential information leakage must be removed before automated review.",
        };
      }
      const reviewer = reviewerForProvider(authorContext?.provider, settings.fallbackReviewer);
      if (!initial.domain.hasTargetDomain) {
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
          unifiedDiff: initialUnifiedDiff.slice(0, 120_000),
          leakage: initialLeakage,
        }),
        timeoutMs: reviewerTimeoutMs,
      });
      if (!reviewResult.ok) {
        throw new Error("Opposite-model reviewer failed; output was withheld from the Check Run.");
      }
      const [finalAnalysis, finalUnifiedDiff] = await Promise.all([
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        }),
        readUnifiedDiff(worktrees.head, worktrees.mergeBase),
      ]);
      const finalLeakage = scanAddedDiffForLeaks(finalUnifiedDiff);
      if (finalLeakage.totalFindings > 0) {
        throw new Error(
          "Opposite-model autofix introduced potential information leakage; changes were discarded before commit or push.",
        );
      }
      const reviewedHeadSha = await commitAndPushAutofix(worktrees.head, request);
      const needsHuman = !finalAnalysis.domain.hasTargetDomain
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
          request,
          firstAnalysis,
          finalAnalysis,
          baseline,
          reviewer,
          contextSource: authorContext?.source ?? "pr-only",
          reviewedHeadSha,
          reviewerOutput: reviewResult.stdout,
          complexityDropThreshold,
          initialLeakage,
          leakage: finalLeakage,
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
