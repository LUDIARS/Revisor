import { analyzePr, ensureInitialAnalysis, resolveAnatomiaCli } from "./anatomia.mjs";
import { resolveServiceLoopbackUrl, resolveWorkspaceRoot } from "./catalog.mjs";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
  notifyConcordia,
  targetDomainQuestion,
} from "./concordia-context.mjs";
import { readSettings } from "./config.mjs";
import { runRegisteredTests, testsPassed } from "./ci.mjs";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { reviewerForProvider, runReviewer } from "./reviewer.mjs";
import { gateOutcome, isDocsOnlyChange, needsTargetDomain } from "./review-gate.mjs";
import {
  advanceLocalBranch,
  cleanupWorktrees,
  git,
  prepareLocalWorktrees,
} from "./workspace.mjs";

// A docs-only change must not be asked for a code domain: the reviewer would
// report PR_GATE_NEEDS_HUMAN, which blocks the merge and would undo the
// relaxation the gate just made for exactly this case.
function domainInstruction({ analysis, docsOnly }) {
  if (needsTargetDomain(analysis, docsOnly)) {
    return [
      "Anatomia found no target domain for the changed functions.",
      "Infer the target domain from the PR diff and optional original-session context.",
      "Add or update both an AIFormat-compatible spec and the minimal .anatomia/domains membership definition so the changed functions are attributable.",
      "Do not invent a domain if the context is insufficient; include PR_GATE_NEEDS_HUMAN in your final response.",
    ].join(" ");
  }
  if (docsOnly) {
    return [
      "This change touches documentation files only, so documentation is its own domain.",
      "Do not add a code domain or .anatomia/domains membership for it, and do not report PR_GATE_NEEDS_HUMAN for a missing target domain.",
      "Do check that the documentation stays consistent with the specs and behaviour it describes.",
    ].join(" ");
  }
  return "Ensure the existing target-domain and spec traceability remains accurate.";
}

function buildReviewerPrompt({
  request,
  analysis,
  authorContext,
  unifiedDiff,
  leakage,
  docsOnly = false,
}) {
  return [
    `Review and autofix PR ${request.repository}#${request.number}.`,
    `Compare the checked-out HEAD with ${request.baseRef}.`,
    "You may read and edit files only. Do not run repository code, install dependencies, use network access, commit, or push; Revisor owns local Git and CI operations.",
    "Perform a normal correctness, security, and maintainability review and directly fix actionable issues.",
    "Explicitly check for information leakage: credentials, personal data, private endpoints, session transcripts, logs, local configuration, and proprietary artifacts that should not enter the repository.",
    `Local high-confidence leakage scan (contains locations only, never matched values):\n${JSON.stringify(leakage, null, 2)}`,
    "Preserve existing user changes and keep edits scoped to this PR.",
    `Anatomia temporary analysis (may be truncated):\n${JSON.stringify(analysis, null, 2).slice(0, 80_000)}`,
    `Unified PR diff (may be truncated):\n${unifiedDiff}`,
    domainInstruction({ analysis, docsOnly }),
    "Resolve newly orphaned functions and avoid a material complexity-score regression where practical.",
    `Original author provider: ${authorContext?.provider ?? "(unavailable; configured fallback reviewer is in use)"}`,
    `Original session context:\n${authorContext?.text || "(Concordia unavailable or no matching session; review from PR evidence only)"}`,
  ].join("\n\n");
}

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
}) {
  const complexityScoreDelta =
    finalAnalysis.quality.complexity.score - baseline.quality.complexity.score;
  const { reasons, advisories } = gateOutcome({
    finalAnalysis,
    complexityScoreDelta,
    threshold: complexityDropThreshold,
    reviewerOutput,
    leakage,
    ci,
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
    ci,
    reasons,
    advisories,
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

// -z keeps paths raw: without it Git C-quotes any path containing non-ASCII
// bytes, and the added quotes would hide a documentation extension and turn a
// docs-only change back into a blocking one.
// `git diff` reports tracked files only, so a not-yet-staged file the reviewer
// created would be invisible here while `git add --all` still commits it. The
// docs-only re-derivation has to see it, otherwise an autofix that adds a new
// code file keeps the change "docs-only" and the missing target domain never
// blocks again. Untracked paths are listed with the same exclusion rules the
// later `git add --all` applies, so both agree on what enters the commit.
async function readChangedPaths(cwd, mergeBase) {
  const outputs = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  // Each output is split on its own: git() trims the trailing NUL, so joining
  // them first would glue the last tracked path onto the first untracked one.
  return [...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean)))];
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
    const repoPath = request.rootPath;
    const firstAnalysis = await ensureInitialAnalysis({
      cliPath: anatomiaCliPath,
      repoPath,
      repository: request.repository,
    });
    const worktrees = await prepareLocalWorktrees(repoPath, request);
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
      const docsOnly = isDocsOnlyChange(
        await readChangedPaths(worktrees.head, worktrees.mergeBase),
      );
      const initialLeakage = scanAddedDiffForLeaks(initialUnifiedDiff);
      const initialCi = await runRegisteredTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        env,
      });
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
            ci: initialCi,
            docsOnly,
          }),
          humanQuestion: needsTargetDomain(initial, docsOnly)
            ? targetDomainQuestion(request.repository, request.number)
            : null,
        };
      }
      if (!testsPassed(initialCi)) {
        return {
          ...buildGateResult({
            request,
            firstAnalysis,
            finalAnalysis: initial,
            baseline,
            reviewer: null,
            contextSource: "registered-tests",
            reviewedHeadSha: request.headSha,
            complexityDropThreshold,
            initialLeakage,
            leakage: initialLeakage,
            ci: initialCi,
            docsOnly,
          }),
          humanQuestion: "Registered tests must pass before automated review.",
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
            ci: initialCi,
            docsOnly,
          }),
          humanQuestion: "Potential information leakage must be removed before automated review.",
        };
      }
      const reviewer = reviewerForProvider(authorContext?.provider, settings.fallbackReviewer);
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
          unifiedDiff: initialUnifiedDiff.slice(0, 120_000),
          leakage: initialLeakage,
          docsOnly,
        }),
        timeoutMs: reviewerTimeoutMs,
      });
      if (!reviewResult.ok) {
        throw new Error("Opposite-model reviewer failed; output was withheld from the Check Run.");
      }
      const [finalAnalysis, finalUnifiedDiff, finalChangedPaths] = await Promise.all([
        analyzePr({
          cliPath: anatomiaCliPath,
          cwd: worktrees.head,
          base: worktrees.mergeBase,
        }),
        readUnifiedDiff(worktrees.head, worktrees.mergeBase),
        readChangedPaths(worktrees.head, worktrees.mergeBase),
      ]);
      // The relaxation must follow the reviewed diff, not the submitted one: an
      // autofix that touches code makes the change no longer docs-only, and the
      // missing target domain has to block again.
      const finalDocsOnly = isDocsOnlyChange(finalChangedPaths);
      const finalLeakage = scanAddedDiffForLeaks(finalUnifiedDiff);
      if (finalLeakage.totalFindings > 0) {
        throw new Error(
          "Opposite-model autofix introduced potential information leakage; changes were discarded before commit or push.",
        );
      }
      const finalCi = await runRegisteredTests({
        worktreePath: worktrees.head,
        testCases: request.testCases,
        env,
      });
      if (!testsPassed(finalCi)) {
        return {
          ...buildGateResult({
            request,
            firstAnalysis,
            finalAnalysis: initial,
            baseline,
            reviewer,
            contextSource: authorContext?.source ?? "pr-only",
            reviewedHeadSha: request.headSha,
            reviewerOutput: reviewResult.stdout,
            complexityDropThreshold,
            initialLeakage,
            leakage: initialLeakage,
            ci: finalCi,
            docsOnly,
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
          ci: finalCi,
          docsOnly: finalDocsOnly,
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
