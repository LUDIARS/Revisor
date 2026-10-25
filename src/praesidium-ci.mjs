/** @implements RV-PRAESIDIUM-04 — mandatory preflight for both ordinary and Augur test paths. */
import { scanRepository } from "./praesidium/scan.mjs";

export async function runSecurePlannedTests(options, { scan = scanRepository, runTests } = {}) {
  const name = "Praesidium security preflight";
  await options.onCheckStarted?.({ name });
  let report;
  try { report = await scan({ root: options.worktreePath }); }
  catch { report = { status: "error", reason: "security inspection failed" }; }
  const status = ["passed", "failed", "error"].includes(report?.status) ? report.status : "error";
  const result = { name, status, durationMs: report?.durationMs ?? 0,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : 2,
    security: report, reason: status === "passed" ? undefined : "Praesidium blocked unsafe or unverified code" };
  if (status !== "passed") {
    const text = JSON.stringify({ reason: report?.reason, findings: report?.findings, checks: report?.checks });
    result.output = { text: text.slice(0, 8000), truncated: text.length > 8000 };
  }
  await options.onCheckResult?.(result);
  if (status !== "passed") return [result];
  // Load the dependency-bearing runner only after preflight passes. The small
  // policy/adapter regression suite must also run in a docs-only cold checkout.
  const executeTests = runTests ?? (await import("./ci.mjs")).runPlannedTests;
  return [result, ...await executeTests(options)];
}
