import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { isGitCommand } from "./git-runtime.mjs";
import { runProcess } from "./process.mjs";
import { selectedTestCases, skippedTestOutcomes } from "./review-plan.mjs";
import { captureFailedTestOutput } from "./test-output.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:61c7a431 */
import augurContract_81e33a0d from '../contracts/run-planned-tests-augur-domain-bundles.contract.mjs'; /* augur-inject:contract-predicate:caf0700f */
import { experienceEvidenceFor } from "./augur-evidence.mjs";

function testCwd(worktreePath, configuredCwd) {
  const path = resolve(worktreePath, configuredCwd);
  const fromRoot = relative(resolve(worktreePath), path);
  if (fromRoot.startsWith("..") || fromRoot === "") {
    if (fromRoot.startsWith("..")) {
      throw new Error(`Test cwd escapes the review worktree: ${configuredCwd}`);
    }
  }
  return path;
}

export function configuredProcess(test, cwd, env, platform = process.platform) {
  if (platform !== "win32" || isGitCommand(test.command, { platform })) {
    return {
      command: test.command,
      args: test.args,
      cwd,
      timeoutMs: test.timeoutMs,
      env,
    };
  }
  return {
    command: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", test.command, ...test.args],
    cwd,
    timeoutMs: test.timeoutMs,
    env,
  };
}

export async function runRegisteredTests({
  worktreePath,
  testCases,
  env = process.env,
  execute = runProcess,
  now = () => Date.now(),
}) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("リポジトリに登録テストがありません");
  }
  const results = [];
  for (const test of testCases) {
    const startedAt = now();
    const result = await execute(configuredProcess(
      test,
      testCwd(worktreePath, test.cwd),
      env,
    ));
    const outcome = {
      name: test.name,
      status: result.ok ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: Math.max(0, now() - startedAt),
    };
    // A failure keeps its (redacted, tail-truncated) output: "1 registered test
    // の失敗だけでは、PR の読者が原因を知るために全スイートを再実行することになる
    // locally to learn what a machine already knew. A pass keeps nothing.
    if (!result.ok) {
      const output = captureFailedTestOutput(result);
      if (output) outcome.output = output;
    }
    results.push(outcome);
  }
  return results;
}

function targetDomainNames(targetDomains) {
  return [...new Set((Array.isArray(targetDomains) ? targetDomains : [])
    .map((domain) => typeof domain === "string" ? domain : domain?.name)
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim()))];
}

function parseRunRecord(stdout) {
  try {
    const record = JSON.parse(stdout);
    return record?.runId && record?.summary ? record : null;
  } catch {
    return null;
  }
}

function augurOutcome(domain, result, durationMs) {
  const record = parseRunRecord(result.stdout ?? "");
  if (record) {
    return {
      name: `動作ブロック (${domain})`,
      domain,
      status: record.status === "passed" ? "passed" : record.status === "failed" ? "failed" : "error",
      total: record.summary.total,
      passed: record.summary.passed,
      failed: record.summary.failed,
      durationMs: record.durationMs ?? durationMs,
      runId: record.runId,
      exitCode: result.exitCode,
    };
  }
  if (result.exitCode === 3 || (result.ok && !String(result.stdout ?? "").trim())) {
    return {
      name: `動作ブロック (${domain})`, domain, status: "skipped", total: 0, passed: 0, failed: 0,
      durationMs, runId: null, exitCode: result.exitCode, reason: `${domain} に登録テストが無い`,
    };
  }
  return {
    name: `動作ブロック (${domain})`, domain, status: "error", total: 0, passed: 0, failed: 0,
    durationMs, runId: null, exitCode: result.exitCode ?? null, reason: `${domain} の動作ブロックを実行できませんでした`,
  };
}

async function runAugurDomainBundles({ worktreePath, targetDomains, augurFolder, env, execute, now, headSha }) {
  const cliPath = join(augurFolder, "bin", "augur.mjs");
  const domains = targetDomainNames(targetDomains);
  if (domains.length === 0) {
    return [{
      name: "動作ブロック (対象ドメインなし)", domain: null, status: "error", total: 0, passed: 0, failed: 0,
      durationMs: 0, runId: null, exitCode: null, reason: "対象ドメインを取得できないため動作ブロックを実行できませんでした",
      augurLedgerPresent: true,
    }];
  }
  if (!augurFolder || !existsSync(cliPath)) {
    return domains.map((domain) => ({
      name: `動作ブロック (${domain})`, domain, status: "error", total: 0, passed: 0, failed: 0,
      durationMs: 0, runId: null, exitCode: null, reason: `${domain} の動作ブロックを実行できませんでした`,
    }));
  }
  const outcomes = await Promise.all(domains.map(async (domain) => {
    const startedAt = now();
    const result = await execute({
      command: process.execPath,
      args: [cliPath, "tests", "run", "--repo", worktreePath, "--bundle", `domain:${domain}`, "--for-revisor", "--json"],
      cwd: worktreePath,
      env,
      timeoutMs: 30 * 60_000,
    });
    return augurOutcome(domain, result, Math.max(0, now() - startedAt));
  }));
  const experience = typeof headSha === "string"
    ? experienceEvidenceFor({ worktreePath, headSha, runIds: outcomes.map((item) => item.runId) })
    : { status: "unverified", count: 0 };
  return [...outcomes, {
    name: "体験ブロック", status: "skipped", durationMs: 0, experience,
    reason: experience.status === "recorded" ? `evidence ${experience.count} 件` : "未確認",
  }];
}

// Executes only the cases the review plan selected and records the rest as
// `skipped` with the reason, so the dashboard shows what was not run instead of
// a shorter list that reads like a smaller suite.
export async function runPlannedTests({
  worktreePath,
  testCases,
  plan,
  targetDomains = [],
  headSha = null,
  augurFolder = "",
  env = process.env,
  execute = runProcess,
  now = () => Date.now(),
}) {
  if (!Array.isArray(testCases) || testCases.length === 0) {
    throw new Error("リポジトリに登録テストがありません");
  }
  const ledgerPresent = existsSync(join(worktreePath, ".augur", "tests.jsonl"));
  // This is an explicit non-code plan, not recovery from a missing code domain.
  // Keep the registered selection (including justified skips) for this route.
  const registeredNonCode = plan?.changeProfile?.codeDomainRequired === false
    && targetDomainNames(targetDomains).length === 0;
  if (ledgerPresent && !registeredNonCode) {
    return await runAugurDomainBundles({ worktreePath, targetDomains, augurFolder, env, execute, now, headSha });
  }
  const selected = selectedTestCases(plan, testCases);
  const executed = selected.length > 0
    ? await runRegisteredTests({ worktreePath, testCases: selected, env, execute, now })
    : [];
  const results = [...executed, ...skippedTestOutcomes(plan)];
  if (ledgerPresent) {
    return results.map((result) => ({
      ...result, augurLedgerPresent: true, testSelectionMode: "registered-non-code",
    }));
  }
  if (results.length > 0) {
    results[0] = { ...results[0], advisory: "Augur 台帳未整備 (全体スイートを実行)" };
  }
  return results;
}
// @ts-expect-error augur-inject
runPlannedTests = contract(runPlannedTests, { ...augurContract_81e33a0d, contractId: 'C-9', mode: 'observe', sample: 1, where: 'src/ci.mjs:76', rule: 'contract-wrap', id: '81e33a0d' }); /* augur-inject:contract-wrap:81e33a0d */

// A skipped case is not a failure: the plan decided the change does not need it.
// Only an actual failing run blocks. An empty result set is still not a pass —
// a repository always has at least one registered case, so nothing to report
// means the run did not happen rather than that it succeeded.
export function testsPassed(results) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((result) => result.status === "passed" || result.status === "skipped");
}
