import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNamedCli } from "./process.mjs";

const MAX_FINDINGS = 100;
// A scanner title or path field can carry an unbounded excerpt of the scanned
// source, so every retained string is capped as well as whitelisted.
const MAX_TEXT_LENGTH = 200;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const SEVERITY_RANK = new Map([
  ["critical", 4],
  ["high", 3],
  ["medium", 2],
  ["low", 1],
]);
const UNREAD_REPORT = "the scan report could not be read";
const UNRANKED_REPORT = "the scan report listed no finding at or above the threshold";

export function skippedSecurityScan(reason) {
  return {
    status: "skipped",
    reason,
    failOnSeverity: null,
    totalFindings: 0,
    findings: [],
  };
}

function text(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
}

// The saved report may contain source excerpts and reproduction steps.
// Revisor stores neither (same policy as the leakage scan): a stored finding
// carries only severity, rule/title, file path, and line number.
function sanitizeFinding(finding) {
  if (!finding || typeof finding !== "object") return null;
  const location = typeof finding.location === "object" && finding.location !== null
    ? finding.location
    : {};
  const line = [finding.line, finding.startLine, location.line, location.startLine]
    .find((value) => Number.isInteger(value));
  return {
    severity: text(finding.severity) ?? "unknown",
    rule: text(finding.rule) ?? text(finding.title) ?? text(finding.name) ?? "unspecified",
    file: text(finding.file) ?? text(finding.path) ?? text(location.file)
      ?? text(location.path) ?? "unknown",
    line: line ?? null,
  };
}

// A report may list sub-threshold findings next to the blocking ones, so the
// count that explains the block must not include them: `--fail-on-severity high`
// with one high and ten low findings blocks on one finding, not eleven. A
// severity the scanner names outside the known scale cannot be ranked, so it is
// kept rather than dropped — the scanner already decided the run blocks.
// Severity names arrive from scanner output, so the lookup must be a Map rather
// than an object index: `severity: "constructor"` would otherwise resolve to an
// inherited function, compare false against every threshold, and silently drop
// the finding the scanner just blocked on. Casing is the scanner's choice too,
// so "HIGH" has to rank the same as "high".
function severityRank(name) {
  return SEVERITY_RANK.get(String(name).toLowerCase());
}

function blocksAt(finding, threshold) {
  const rank = severityRank(finding.severity);
  return rank === undefined || rank >= threshold;
}

function extractFindings(stdout, failOnSeverity) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const candidates = [
    parsed?.findings?.findings,
    parsed?.findings,
    parsed?.results?.findings,
    parsed?.results,
  ];
  const list = candidates.find(Array.isArray);
  if (!list) return null;
  // An unrecognised threshold keeps every finding in the count rather than
  // silently comparing against `undefined` and dropping all of them.
  const threshold = severityRank(failOnSeverity) ?? SEVERITY_RANK.get("low");
  const sanitized = list
    .map(sanitizeFinding)
    .filter((finding) => finding && blocksAt(finding, threshold));
  // Only a bounded number of findings is retained, so the reported total is
  // taken before truncation and never understates what the scanner returned.
  return { total: sanitized.length, findings: sanitized.slice(0, MAX_FINDINGS) };
}

function scanArgs({ worktreePath, diffBase, settings, outputDir }) {
  return [
    "scan",
    worktreePath,
    "--diff",
    diffBase,
    "--json",
    // effort は必ず明示する。 codex-security の既定は xhigh で、 PR ごとに走らせると
    // 推論コストが --max-cost を先に食い潰してスキャンが自己中断し、 exit 2 =
    // 「未完了」 としてマージをブロックしてしまう。 「完走すること」 を優先し、
    // 深さが必要なリポだけ設定 (securityScanEffort) で上げる。
    "--effort",
    settings.securityScanEffort,
    // 空なら CLI 既定モデルに任せる (安いモデルへ寄せたいときだけ設定)。
    ...(settings.securityScanModel ? ["--model", settings.securityScanModel] : []),
    // Pinned to the ChatGPT/Codex subscription sign-in (neco 2026-07-30): the
    // default "auto" would silently switch to metered API billing whenever an
    // OPENAI_API_KEY/CODEX_API_KEY happens to be present in the service env.
    "--auth",
    "chatgpt",
    "--output-dir",
    outputDir,
    "--fail-on-severity",
    settings.securityFailOnSeverity,
    "--max-cost",
    String(settings.securityMaxCostUsd),
  ];
}

// Runs `codex-security scan` on the committed diff of a disposable review
// worktree. Exit code 0 is a pass, 1 means findings at or above the configured
// severity, and anything else (including a missing or unauthenticated CLI, an
// incomplete scan, or a timeout) is an error that must not read as a pass.
export async function runSecurityScan({
  worktreePath,
  diffBase,
  settings,
  execute = runNamedCli,
  makeOutputDir = () => mkdtemp(join(tmpdir(), "revisor-security-scan-")),
  removeOutputDir = (path) => rm(path, { recursive: true, force: true }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!settings.securityScanEnabled) {
    return skippedSecurityScan("disabled by settings");
  }
  const outputDir = await makeOutputDir();
  let result;
  try {
    result = await execute({
      name: "codex-security",
      args: scanArgs({ worktreePath, diffBase, settings, outputDir }),
      cwd: worktreePath,
      timeoutMs,
    });
  } finally {
    // Report artifacts keep source excerpts on disk; Revisor must not.
    await removeOutputDir(outputDir);
  }
  const base = {
    reason: null,
    failOnSeverity: settings.securityFailOnSeverity,
    totalFindings: 0,
    findings: [],
  };
  if (result.exitCode === 0) {
    return { ...base, status: "passed" };
  }
  if (result.exitCode === 1) {
    const extracted = extractFindings(result.stdout, settings.securityFailOnSeverity);
    // Exit code 1 means the scanner found something at or above the threshold,
    // so an unreadable or empty report still reports one finding rather than a
    // blocking status with a "0 finding(s)" explanation. That count is then a
    // floor rather than a measurement — a CLI usage error that also exits 1
    // would otherwise read as exactly one real finding — so both ways of
    // reaching the floor are named in the blocking explanation.
    return {
      ...base,
      status: "findings",
      reason: extracted
        ? (extracted.total === 0 ? UNRANKED_REPORT : null)
        : UNREAD_REPORT,
      totalFindings: Math.max(extracted?.total ?? 1, 1),
      findings: extracted?.findings ?? [],
    };
  }
  return {
    ...base,
    status: "error",
    // stderr may quote scanned content, so only the exit code is retained.
    reason: result.exitCode === null
      ? "codex-security did not finish (timeout or spawn failure)"
      : `codex-security exited with code ${result.exitCode}`,
  };
}
