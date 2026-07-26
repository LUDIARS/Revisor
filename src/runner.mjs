import { analyzePr, ensureInitialAnalysis, resolveAnatomiaCli } from "./anatomia.mjs";
import { resolveServiceLoopbackUrl, resolveWorkspaceRoot } from "./catalog.mjs";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
  notifyConcordia,
  targetDomainQuestion,
} from "./concordia-context.mjs";
import { readSettings } from "./config.mjs";
import { reviewerForProvider, runReviewer } from "./reviewer.mjs";
import {
  cleanupWorktrees,
  git,
  prepareWorktrees,
  resolveRepositoryPath,
} from "./workspace.mjs";

function buildReviewerPrompt({ request, analysis, authorContext, unifiedDiff }) {
  const needsDomain = !analysis.domain.hasTargetDomain;
  return [
    `Review and autofix PR ${request.repository}#${request.number}.`,
    `Compare the checked-out HEAD with ${request.baseRef}.`,
    "You may read and edit files only. Do not run repository code, install dependencies, use network access, commit, or push; Revisor owns Git operations and GitHub CI owns execution.",
    "Perform a normal correctness, security, and maintainability review and directly fix actionable issues.",
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
    await git(cwd, ["commit", "-m", "fix(pr-review): apply automated review fixes"]);
  }
  const reviewedHead = await git(cwd, ["rev-parse", "HEAD"]);
  if (reviewedHead.toLowerCase() !== request.headSha.toLowerCase()) {
    await git(cwd, ["push", "origin", `HEAD:refs/heads/${request.headRef}`]);
  }
  return reviewedHead;
}

function gateReasons(finalAnalysis, complexityScoreDelta, threshold, reviewerOutput) {
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
    const reviewer = reviewerForProvider(authorContext?.provider, settings.fallbackReviewer);
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
          unifiedDiff: (await git(worktrees.head, [
            "diff",
            "--no-ext-diff",
            worktrees.mergeBase,
            "--",
          ])).slice(0, 120_000),
        }),
        timeoutMs: reviewerTimeoutMs,
      });
      if (!reviewResult.ok) {
        throw new Error(`Opposite-model reviewer failed: ${
          reviewResult.stderr.trim() || reviewResult.stdout.trim()
        }`);
      }
      const reviewedHeadSha = await commitAndPushAutofix(worktrees.head, request);
      const finalAnalysis = await analyzePr({
        cliPath: anatomiaCliPath,
        cwd: worktrees.head,
        base: worktrees.mergeBase,
      });
      const complexityScoreDelta =
        finalAnalysis.quality.complexity.score - baseline.quality.complexity.score;
      const reasons = gateReasons(
        finalAnalysis,
        complexityScoreDelta,
        complexityDropThreshold,
        reviewResult.stdout,
      );
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
        conclusion: reasons.length === 0 ? "success" : "action_required",
        reviewer,
        contextSource: authorContext?.source ?? "pr-only",
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
        reasons,
        humanQuestion: needsHuman
          ? targetDomainQuestion(request.repository, request.number)
          : null,
      };
    } finally {
      await cleanupWorktrees(repoPath, worktrees);
    }
  };
}
