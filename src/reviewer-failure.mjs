import { serviceLog } from "./service-log.mjs";

// Even redacted provider output may contain repository content. Export only
// fixed classifications, never the text that produced them.
/** @implements SPEC-REVIEWER-FAILURE-DIAGNOSTICS */
export function reviewerFailureSummary(stage, result) {
  const output = `${typeof result?.stderr === "string" ? result.stderr : ""}\n${typeof result?.stdout === "string" ? result.stdout : ""}`;
  let category = "unknown";
  if (/process timed out|\bETIMEDOUT\b/i.test(output)) category = "timeout";
  else if (/rate[_ -]?limit|\b429\b|quota|usage limit|credit balance|overloaded|monthly spend limit|you(?:'ve| have) hit your limit/i.test(output)) category = "capacity";
  else if (/\b401\b|unauthorized|authentication failed|not logged in|login required|invalid api key/i.test(output)) category = "authentication";
  else if (/\bENOENT\b|command not found|is not recognized as an internal or external command/i.test(output)) category = "launch";
  else if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(output)) category = "permission";
  return {
    stage: ["investigation", "review"].includes(stage) ? stage : "unknown",
    reviewer: ["claude-opus", "codex-sol"].includes(result?.reviewer) ? result.reviewer : "unknown",
    exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
    category,
  };
}

/** @implements SPEC-REVIEWER-FAILURE-DIAGNOSTICS */
export function reviewerFailureError(stage, result, { log = serviceLog } = {}) {
  const summary = reviewerFailureSummary(stage, result);
  try {
    log("reviewer_invocation_failed", summary, { level: "warn" });
  } catch {
    // Diagnostics must not replace the terminal review failure.
  }
  const prefix = summary.stage === "investigation"
    ? "Review investigation failed" : "Opposite-model reviewer failed";
  return new Error(`${prefix}; output was withheld from the Check Run. `
    + `[stage=${summary.stage}; reviewer=${summary.reviewer}; category=${summary.category}; exitCode=${summary.exitCode ?? "unknown"}]`);
}
