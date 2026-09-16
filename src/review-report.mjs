import { redactSecretLines } from "./leakage.mjs";

export const REVIEW_REPORT_VERSION = 1;

/**
 * Masks every string before a structured record is serialized. Serialized JSON is a single
 * line, so masking the finished document would drop the whole entry for one secret-looking
 * fragment, and a masked line inside JSON can no longer be turned back into readable text.
 * @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT
 */
function redactStrings(value) {
  if (typeof value === "string") return redactSecretLines(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item)]));
  }
  return value;
}

/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
function safeText(value) {
  if (typeof value === "string") return redactSecretLines(value);
  return JSON.stringify(redactStrings(value ?? null));
}

/**
 * The reviewer's own review text, masked line by line. Empty output is recorded as null so
 * a consumer can tell "no review text" apart from a record written before it was kept.
 * @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT
 */
export function redactedReviewerOutput(value) {
  return typeof value === "string" && value.trim() ? redactSecretLines(value) : null;
}

function behaviorBlock(ci) {
  const runs = Array.isArray(ci) ? ci.filter((item) => typeof item?.domain === "string") : [];
  if (runs.length === 0) return { status: "台帳未整備", runs: [] };
  return {
    status: "記録済み",
    runs: runs.map((run) => ({
      domain: run.domain,
      passed: Number.isFinite(run.passed) ? run.passed : 0,
      failed: Number.isFinite(run.failed) ? run.failed : 0,
      durationMs: Number.isFinite(run.durationMs) ? run.durationMs : 0,
      runId: run.runId ?? null,
    })),
  };
}

function experienceBlock(ci) {
  const experience = Array.isArray(ci) ? ci.find((item) => item?.experience)?.experience : null;
  return experience?.status === "recorded"
    ? { status: "記録済み", count: experience.count }
    : { status: "未確認", count: 0 };
}

export function reviewBlockLines(ci) {
  const behavior = behaviorBlock(ci);
  const behaviorLine = behavior.status === "台帳未整備"
    ? "動作ブロック: 台帳未整備"
    : behavior.runs.map((run) => `動作ブロック: ${run.domain} / passed ${run.passed} / failed ${run.failed} / ${run.durationMs}ms / runId ${run.runId ?? "未確認"}`);
  const experience = experienceBlock(ci);
  return [
    ...(Array.isArray(behaviorLine) ? behaviorLine : [behaviorLine]),
    experience.status === "記録済み" ? `体験ブロック: evidence ${experience.count} 件` : "体験ブロック: 未確認",
  ];
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
    return {
      kind: "check",
      label: "動作ブロック・体験ブロック",
      content: { 動作ブロック: behaviorBlock(payload?.ci), 体験ブロック: experienceBlock(payload?.ci) },
    };
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
    content: {
      reviewer: payload?.reviewer ?? null,
      plan: payload?.plan ?? null,
      reviewerOutput: payload?.reviewerOutput ?? null,
    },
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
      reviewerOutput: result?.reviewerOutput ?? null,
      reusedStages: result?.reusedStages ?? [],
      security: result?.security ?? null,
      ci: result?.ci ?? [],
      anatomiaGate: result?.anatomiaGate ?? null,
    },
  };
}
