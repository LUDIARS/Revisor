import { redactSecretLines } from "./leakage.mjs";

export const REVIEW_REPORT_VERSION = 1;

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
function safeText(value) {
  return redactSecretLines(typeof value === "string" ? value : JSON.stringify(value ?? null));
}

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
function isoTime(value) {
  const at = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)) {
    throw new TypeError("Review report entries require an ISO UTC timestamp.");
  }
  return at;
}

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
export function createReviewReport({ attemptId, headSha, at, content = "Review started." }) {
  return updateReviewReport(null, {
    id: "review-start",
    kind: "review",
    label: "Review started",
    status: "running",
    at,
    content,
  }, { attemptId, headSha });
}

/**
 * Replaces an entry with the same stable attempt-local id instead of accumulating
 * duplicate progress records. The complete report remains on the PR record, so a
 * consumer can refetch it after the identifier-only event-stream invalidation.
 */
/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
export function updateReviewReport(report, entry, { attemptId, headSha } = {}) {
  const activeAttemptId = String(attemptId ?? report?.attemptId ?? "");
  const activeHeadSha = String(headSha ?? report?.headSha ?? "");
  if (!activeAttemptId || !activeHeadSha) {
    throw new TypeError("Review reports require an attempt id and head SHA.");
  }
  if (!entry || typeof entry.id !== "string" || !entry.id) {
    throw new TypeError("Review report entries require a stable id.");
  }
  const next = {
    id: entry.id,
    kind: String(entry.kind ?? "review"),
    label: safeText(entry.label ?? entry.id),
    status: String(entry.status ?? "unknown"),
    at: isoTime(entry.at),
    content: safeText(entry.content),
  };
  const entries = Array.isArray(report?.entries) && report.version === REVIEW_REPORT_VERSION
    && report.attemptId === activeAttemptId && report.headSha === activeHeadSha
    ? report.entries.filter((item) => item?.id !== next.id)
    : [];
  return {
    version: REVIEW_REPORT_VERSION,
    attemptId: activeAttemptId,
    headSha: activeHeadSha,
    entries: [...entries, next],
  };
}

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
export function reviewReportEntry(stage, payload) {
  if (stage === "tests") {
    return { kind: "check", label: "Registered tests", content: payload?.ci ?? [] };
  }
  if (stage === "anatomia") {
    const analysis = payload?.analysis;
    return {
      kind: "check",
      label: "Anatomia analysis",
      content: {
        domains: analysis?.domain?.targetDomains?.map((item) => item.name) ?? [],
        verify: analysis?.architecture?.verify ?? null,
        changedViolations: analysis?.architecture?.changedViolations ?? [],
        changedFunctions: analysis?.quality?.changedFunctions ?? [],
      },
    };
  }
  if (stage === "security") {
    return { kind: "check", label: "Security scan", content: payload?.security ?? null };
  }
  return {
    kind: "review",
    label: "Reviewer assessment",
    content: { reviewer: payload?.reviewer ?? null, plan: payload?.plan ?? null },
  };
}

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
export function finalReviewReportEntry(result, error = null) {
  if (error) {
    return { kind: "outcome", label: "Review failed", status: "failed", content: error };
  }
  const passed = result?.conclusion === "success";
  return {
    kind: "outcome",
    label: passed ? "Review completed" : "Review requires action",
    status: passed ? "passed" : "action_required",
    content: {
      conclusion: result?.conclusion ?? null,
      reasons: result?.reasons ?? [],
      advisories: result?.advisories ?? [],
      reviewer: result?.reviewer ?? null,
      security: result?.security ?? null,
      ci: result?.ci ?? [],
      anatomiaGate: result?.anatomiaGate ?? null,
    },
  };
}
