import { classifyPath } from "./change-classification.mjs";

export const DEFAULT_LARGE_REVIEW_LINE_THRESHOLD = 1_000;
export const DEFAULT_MULTI_DOMAIN_REVIEW_THRESHOLD = 3;

function diffPath(line) {
  const quoted = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
  if (quoted) return quoted[2];
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return match?.[2] ?? null;
}

export function codeChangedLines(unifiedDiff) {
  let path = null;
  let count = 0;
  for (const line of String(unifiedDiff ?? "").split(/\r?\n/)) {
    path = diffPath(line) ?? path;
    if (!path || classifyPath(path) !== "code") continue;
    if (/^(?:\+\+\+|---) /.test(line)) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}

export function editedDomainCount(analysis) {
  const targetDomains = analysis?.domain?.targetDomains;
  if (!Array.isArray(targetDomains)) return 0;
  return new Set(targetDomains
    .map((domain, index) => ({ domain, index }))
    .filter(({ domain }) => domain?.changedAnchors?.length > 0)
    .map(({ domain, index }) => domain.name || `unnamed:${index}`)).size;
}

export function assertMeaningfulReviewDiff({ changedPaths, unifiedDiff }) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    throw new Error("Review diff is empty; verify the registered base branch before retrying.");
  }
  if (!String(unifiedDiff ?? "").trim()) {
    throw new Error("Review diff has paths but no patch; verify the registered base branch before retrying.");
  }
}

export function selectReviewStrategy({ classification, unifiedDiff, analysis, settings }) {
  const codeLines = codeChangedLines(unifiedDiff);
  const domains = editedDomainCount(analysis);
  const largeThreshold = settings?.largeReviewLineThreshold
    ?? DEFAULT_LARGE_REVIEW_LINE_THRESHOLD;
  const domainThreshold = settings?.multiDomainReviewThreshold
    ?? DEFAULT_MULTI_DOMAIN_REVIEW_THRESHOLD;

  if (codeLines > largeThreshold) {
    return {
      mode: "multi-agent",
      reason: "large-code-diff",
      codeChangedLines: codeLines,
      editedDomains: domains,
      investigator: { effort: "medium" },
      judge: { effort: "high" },
    };
  }
  if ((classification?.counts?.code ?? 0) > 0 && domains >= domainThreshold) {
    return {
      mode: "single-agent",
      reason: "multi-domain",
      codeChangedLines: codeLines,
      editedDomains: domains,
      judge: { effort: "high" },
    };
  }
  return {
    mode: "single-agent",
    reason: classification?.codeDomainRequired ? "focused-code" : "non-code",
    codeChangedLines: codeLines,
    editedDomains: domains,
    judge: { effort: "medium" },
  };
}

export function investigationPrompt({ request, analysis, unifiedDiff }) {
  return [
    "You are the investigation agent in a two-agent pull-request review.",
    "Inspect only: do not edit files, run autofix, commit, push, or make the final gate decision.",
    "Find concrete correctness, security, architecture, test, and compatibility risks.",
    "Return concise evidence with file paths and suggested verification for the judgment agent.",
    `Repository: ${request.repository}`,
    `PR: #${request.number}`,
    `Anatomia: ${JSON.stringify(analysis)}`,
    "Diff:",
    unifiedDiff.slice(0, 120_000),
  ].join("\n\n");
}
