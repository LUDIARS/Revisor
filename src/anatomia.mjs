import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./process.mjs";

export const REVISOR_ANATOMIA_MODEL = "claude-sonnet-4-6";

function analysisEnv(extra = {}) {
  return {
    ...process.env,
    // Anatomia's current PR path is deterministic, but its provider-capable
    // phases default to Opus. Pin Revisor-owned analysis one tier lower so a
    // future/provider-enabled phase cannot silently restore the costly default.
    ANATOMIA_LLM_MODEL: process.env.REVISOR_ANATOMIA_MODEL || REVISOR_ANATOMIA_MODEL,
    ...extra,
  };
}

function normalizePath(path) {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function runAnatomia(cliPath, cwd, args, timeoutMs = 10 * 60_000) {
  const result = await runProcess({
    command: process.execPath,
    args: [cliPath, ...args],
    cwd,
    timeoutMs,
    env: analysisEnv(),
  });
  if (!result.ok) {
    throw new Error(`Anatomia ${args.slice(0, 2).join(" ")} failed: ${
      result.stderr.trim() || result.stdout.trim()
    }`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function isBlockingDualLayerAnalysis(analysis) {
  return analysis?.domain?.dualLayer?.blocking === true
    || analysis?.spec?.dualLayer?.blocking === true;
}

export async function resolveAnatomiaCli(anatomiaFolder) {
  if (typeof anatomiaFolder !== "string" || !anatomiaFolder.trim()) {
    throw new Error("Anatomia folder is not configured");
  }
  const resolvedFolder = resolve(anatomiaFolder);
  const cliPath = join(resolvedFolder, "bin", "anatomia.mjs");
  await access(cliPath);
  process.stderr.write(`[anatomia] anatomiaFolder resolved to ${JSON.stringify(resolvedFolder)}\n`);
  return cliPath;
}

export async function ensureInitialAnalysis({ cliPath, repoPath, repository }) {
  const listed = parseJson(
    await runAnatomia(cliPath, repoPath, ["project", "list", "--json"]),
    "Anatomia project list",
  );
  const normalizedRepo = normalizePath(repoPath);
  let project = listed.projects?.find((candidate) =>
    normalizePath(candidate.rootPath) === normalizedRepo);
  if (!project) {
    project = parseJson(
      await runAnatomia(cliPath, repoPath, [
        "project",
        "add",
        repository.split("/").at(-1),
        repoPath,
        "--json",
      ]),
      "Anatomia project add",
    );
  }
  const analysis = parseJson(
    await runAnatomia(cliPath, repoPath, ["project", "analyze", project.id, "--json"]),
    "Anatomia project analyze",
  );
  return { project, analysis };
}

// The dual-layer domain gate is advisory unless Revisor is configured to enforce
// it. Only then is the flag forwarded, so Anatomia's own exit code (which turns
// non-zero on a blocking dual-layer finding) stays unchanged in advisory mode.
export async function analyzePr({
  cliPath,
  cwd,
  base,
  enforceDualLayerDomainGate = false,
  run = runProcess,
}) {
  const result = await run({
    command: process.execPath,
    args: [
      cliPath,
      "pr-review",
      "--repo",
      cwd,
      "--base",
      base,
      "--json",
      ...(enforceDualLayerDomainGate === true ? ["--enforce-dual-layer-domain-gate"] : []),
    ],
    cwd,
    timeoutMs: 10 * 60_000,
    env: analysisEnv({ ANATOMIA_CACHE: "off" }),
  });
  if (!result.ok) {
    // In enforced mode, Anatomia intentionally exits non-zero after emitting
    // the JSON verdict for a blocking dual-layer finding. Preserve that verdict
    // so the caller blocks the PR instead of treating enforcement as an
    // unavailable analysis. Other non-zero exits remain analysis failures.
    if (enforceDualLayerDomainGate === true) {
      try {
        const analysis = parseJson(result.stdout, "Anatomia PR analysis");
        if (isBlockingDualLayerAnalysis(analysis)) return analysis;
      } catch {
        // The normal error below deliberately omits potentially sensitive CLI output.
      }
    }
    throw new Error(`Anatomia PR analysis failed: ${
      result.stderr.trim() || result.stdout.trim()
    }`);
  }
  return parseJson(result.stdout, "Anatomia PR analysis");
}
