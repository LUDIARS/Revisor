/** @implements RV-PRAESIDIUM-01 — no external model/network and no imported program execution. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { containedFile, trackedSources } from "./files.mjs";
import { sourceFindings } from "./rules.mjs";
import { analyzeNative } from "./native.mjs";
import { checkWebContracts } from "./web-contracts.mjs";

function configuration(root) {
  if (!existsSync(join(root, "praesidium.json"))) return { native: [], web: [] };
  const file = containedFile(root, "praesidium.json");
  if (statSync(file).size > 1024 * 1024) throw new Error("configuration size limit");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config || config.version !== 1 || Object.keys(config).some(key => !["version", "native", "web"].includes(key))) throw new Error("invalid configuration");
  return config;
}

export async function scanRepository({ root, collect = trackedSources, nativeExecute, now = Date.now }) {
  const started = now();
  try {
    const sources = collect(root), config = configuration(root);
    const findings = [];
    let inspectedFiles = 0;
    for (const { file, source } of sources) {
      if (findings.length >= 1000) break; // Already blocked; bound both work and report size.
      findings.push(...sourceFindings(file, source).slice(0, 1000 - findings.length));
      inspectedFiles++;
    }
    const native = await analyzeNative(root, sources, config.native, nativeExecute);
    const web = checkWebContracts(config.web);
    const checks = [...native, ...web];
    const status = checks.some(check => check.status === "error") ? "error"
      : findings.length || checks.some(check => check.status === "failed") ? "failed" : "passed";
    return { tool: "Praesidium", version: 1, status, findings, checks,
      coverage: { sourceFiles: sources.length, policyInspectedFiles: inspectedFiles,
        findingsLimited: findings.length >= 1000 || findings.some(item => item.rule === "inspection.finding-limit"),
        nativeUnits: native.filter(item => item.file).length,
        webContracts: web.length, webRuntimeWiring: "not-verified", scope: "tracked and nonignored new source files; submodules and unsupported languages are not analyzed" },
      durationMs: Math.max(0, now() - started) };
  } catch {
    // Never retain source text, compiler output or parser messages containing secrets.
    return { tool: "Praesidium", version: 1, status: "error", findings: [], checks: [],
      reason: "inspection incomplete: check repository files, limits and praesidium.json",
      durationMs: Math.max(0, now() - started) };
  }
}
