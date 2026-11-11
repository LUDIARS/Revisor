/**
 * @implements RV-CPP-CODE-CHECKS-01 — run Anatomia's C++ code-level checks on a PR's changed C++ files.
 *
 * Anatomia owns the checks (`anatomia code-check`, deterministic, no LLM);
 * Revisor owns the review question: did *this PR* write a line that breaks a
 * blocking rule? Error-severity findings on written lines fail the check;
 * everything else on written lines is carried as advisory evidence.
 *
 * Fail closed: once a PR touches C++, an unresolvable Anatomia, an unknown
 * changed set or an unreadable report is an `error` result, never a pass.
 * The one exception is an Anatomia that answers "unknown subcommand" for
 * `code-check`: the check does not exist there yet, so the row is `skipped`.
 *
 * SRP: one registered-check result for the C++ code checks.
 */
import { resolveAnatomiaCli } from "../anatomia.mjs";
import { changedSourcePaths } from "../praesidium/files.mjs";
import { runProcess } from "../process.mjs";
import { CPP_SOURCE, WHOLE_FILE, isWrittenLine, parseWrittenLines } from "./changed-lines.mjs";

export const CPP_CODE_CHECK_NAME = "C++ code checks (Anatomia)";
const TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 8000;
const SEVERITIES = new Set(["error", "warning", "info"]);

function errorResult(reason, startedAt, now) {
  return { name: CPP_CODE_CHECK_NAME, status: "error", exitCode: 2, durationMs: now() - startedAt, reason };
}

// Anatomia's CLI answers a subcommand it does not have with this fixed line
// (src/adapters/cli.ts) and a non-zero exit. Only that exact answer means the
// check is not implemented yet; any other failure stays an error.
const UNKNOWN_CODE_CHECK = /Unknown subcommand "code-check"/;
export const CODE_CHECK_UNIMPLEMENTED_REASON = "Anatomia に code-check が未実装のため C++ code checks を省略";

function codeCheckUnimplemented(result) {
  return result.exitCode !== 0 && result.exitCode !== null
    && UNKNOWN_CODE_CHECK.test(`${result.stderr ?? ""}
${result.stdout ?? ""}`);
}

function validReport(report) {
  return report?.version === 1
    && Array.isArray(report.findings)
    && report.findings.every((f) => typeof f?.file === "string" && Number.isInteger(f.line)
      && typeof f.rule === "string" && SEVERITIES.has(f.severity));
}

function describe(finding) {
  return `${finding.file}:${finding.line}: ${finding.severity}: ${finding.message ?? ""} [${finding.rule}]`;
}

async function writtenLines({ worktreePath, mergeBase, files, env, run }) {
  const diff = await run({
    command: "git",
    args: ["diff", "-U0", "--no-color", "--no-renames", "--diff-filter=d", mergeBase, "--", ...files],
    cwd: worktreePath,
    env,
    timeoutMs: 60_000,
  });
  if (!diff.ok) throw new Error("git diff failed");
  const written = parseWrittenLines(diff.stdout);
  // A changed path git diff does not list is a new, untracked file: all of it is the PR's.
  for (const file of files) if (!written.has(file)) written.set(file, WHOLE_FILE);
  return written;
}

/**
 * Returns the check result, or `null` when the PR changed no C++ source (the
 * check does not apply, so it adds no row to the registered results).
 */
export async function runCppCodeChecks(options, {
  changes = changedSourcePaths,
  resolveCli = resolveAnatomiaCli,
  run = runProcess,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const { worktreePath, mergeBase, anatomiaFolder } = options;
  const env = options.env ?? process.env;
  if (!mergeBase) {
    // Without a base the PR's own files are unknown. A repository with no C++
    // has nothing this check could judge; one with C++ cannot be cleared.
    const listing = await run({ command: "git", args: ["ls-files", "-z"], cwd: worktreePath, env, timeoutMs: 60_000 });
    if (listing.ok && !listing.stdout.split("\0").some((file) => CPP_SOURCE.test(file))) return null;
    await options.onCheckStarted?.({ name: CPP_CODE_CHECK_NAME });
    return errorResult("the PR's merge base is unknown, so its changed C++ files cannot be determined", startedAt, now);
  }
  let files;
  try {
    files = changes(worktreePath, mergeBase).filter((file) => CPP_SOURCE.test(file)).sort();
  } catch {
    await options.onCheckStarted?.({ name: CPP_CODE_CHECK_NAME });
    return errorResult("the PR's changed files could not be listed", startedAt, now);
  }
  if (files.length === 0) return null;
  await options.onCheckStarted?.({ name: CPP_CODE_CHECK_NAME });

  let cliPath;
  try {
    cliPath = await resolveCli(anatomiaFolder);
  } catch {
    // The resolver message can carry a local path; the persisted reason names the phase only.
    return errorResult("Anatomia CLI could not be resolved (settings: anatomiaFolder)", startedAt, now);
  }

  let written;
  try {
    written = await writtenLines({ worktreePath, mergeBase, files, env, run });
  } catch {
    return errorResult("the PR's written lines could not be read from git", startedAt, now);
  }

  const result = await run({
    command: process.execPath,
    args: [cliPath, "code-check", "--repo", worktreePath, "--files-from", "-", "--json", "--fail-on", "none"],
    cwd: worktreePath,
    stdin: `${files.join("\n")}\n`,
    env,
    timeoutMs: TIMEOUT_MS,
  });
  if (codeCheckUnimplemented(result)) {
    return {
      name: CPP_CODE_CHECK_NAME,
      status: "skipped",
      exitCode: result.exitCode,
      durationMs: now() - startedAt,
      reason: CODE_CHECK_UNIMPLEMENTED_REASON,
      advisory: CODE_CHECK_UNIMPLEMENTED_REASON,
    };
  }
  let report;
  try {
    report = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
  } catch {
    report = null;
  }
  if (!validReport(report)) {
    return errorResult("anatomia code-check did not return a version 1 report", startedAt, now);
  }

  const scoped = report.findings.filter((finding) => isWrittenLine(written, finding.file, finding.line));
  const blocking = scoped.filter((finding) => finding.severity === "error");
  const advisories = scoped.filter((finding) => finding.severity !== "error");
  const counts = { error: blocking.length, warning: 0, info: 0 };
  for (const finding of advisories) counts[finding.severity] += 1;
  const status = blocking.length > 0 ? "failed" : "passed";
  const check = {
    name: CPP_CODE_CHECK_NAME,
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: now() - startedAt,
    codeChecks: {
      files: files.length,
      writtenFindings: counts,
      outsideWrittenLines: report.findings.length - scoped.length,
      parseErrors: Array.isArray(report.parseErrors) ? report.parseErrors.length : 0,
    },
    reason: status === "failed" ? `${blocking.length} blocking C++ finding(s) on lines this PR wrote` : undefined,
  };
  if (scoped.length > 0) {
    const text = [...blocking, ...advisories].map(describe).join("\n");
    check.output = { text: text.slice(0, OUTPUT_LIMIT), truncated: text.length > OUTPUT_LIMIT };
  }
  return check;
}
