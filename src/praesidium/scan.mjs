/** @implements RV-PRAESIDIUM-01 — no external model/network and no imported program execution. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { containedFile, trackedSources } from "./files.mjs";
import { sourceFindings } from "./rules.mjs";
import { analyzeNative } from "./native.mjs";
import { checkWebContracts } from "./web-contracts.mjs";
import { collectionErrorCode } from "./collection-errors.mjs";
import { contract } from '../contract-runtime.mjs'; /* augur-inject:import:3f83ecad */
import augurContract_02bbc11b from '../../contracts/praesidium-input-reasons.contract.mjs'; /* augur-inject:contract-predicate:5bf42227 */

function configuration(root) {
  if (!existsSync(join(root, "praesidium.json"))) return { native: [], web: [] };
  const file = containedFile(root, "praesidium.json");
  if (statSync(file).size > 1024 * 1024) throw new Error("configuration size limit");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config || config.version !== 1 || Object.keys(config).some(key => !["version", "native", "web"].includes(key))) throw new Error("invalid configuration");
  return config;
}

// `changedPaths` scopes native analysis to the reviewed change. Undefined or invalid
// means the change is unknown, so native analysis keeps its whole-repository scope.
export async function scanRepository({ root, collect = trackedSources, changedPaths, nativeExecute, nativeHost, env = process.env, now = Date.now }) {
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
    const changed = Array.isArray(changedPaths) && changedPaths.every(path => typeof path === "string")
      ? new Set(changedPaths) : null;
    const native = await analyzeNative(root, sources, config.native, nativeExecute, { host: nativeHost, env, now, changed });
    const web = checkWebContracts(config.web);
    const checks = [...native, ...web];
    const status = checks.some(check => check.status === "error") ? "error"
      : findings.length || checks.some(check => check.status === "failed") ? "failed" : "passed";
    return { tool: "Praesidium", version: 1, status, findings, checks,
      coverage: { sourceFiles: sources.length, policyInspectedFiles: inspectedFiles,
        findingsLimited: findings.length >= 1000 || findings.some(item => item.rule === "inspection.finding-limit"),
        nativeUnits: native.filter(item => item.file).length, nativeScope: changed ? "changed" : "repository",
        webContracts: web.length, webRuntimeWiring: "not-verified", scope: "tracked and nonignored new source files; submodules and unsupported languages are not analyzed" },
      durationMs: Math.max(0, now() - started) };
  } catch (error) {
    // Never retain source text, compiler output or parser messages containing secrets.
    const reasonCode = collectionErrorCode(error);
    return { tool: "Praesidium", version: 1, status: "error", findings: [], checks: [],
      reason: "inspection incomplete: check repository files, limits and praesidium.json",
      ...(reasonCode ? { reasonCode } : {}),
      durationMs: Math.max(0, now() - started) };
  }
}
// @ts-expect-error augur-inject
scanRepository = contract(scanRepository, { ...augurContract_02bbc11b, contractId: 'C-21', mode: 'observe', sample: 1, where: 'src/praesidium/scan.mjs:21', rule: 'contract-wrap', id: '02bbc11b' }); /* augur-inject:contract-wrap:02bbc11b */
