/** @implements RV-PRAESIDIUM-01 — no external model/network and no imported program execution. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { containedFile, trackedSources } from "./files.mjs";
import { sourceFindings } from "./rules.mjs";
import { analyzeNative, declaredLanguages, NativeConfigurationError, unanalyzedPlatformUnits } from "./native.mjs";
import { checkWebContracts } from "./web-contracts.mjs";

function configuration(root) {
  if (!existsSync(join(root, "praesidium.json"))) return { native: [], web: [] };
  const file = containedFile(root, "praesidium.json");
  if (statSync(file).size > 1024 * 1024) throw new Error("configuration size limit");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (!config || config.version !== 1 || Object.keys(config).some(key => !["version", "native", "web"].includes(key))) throw new Error("invalid configuration");
  return config;
}

const findingKey = item => `${item.rule}\0${item.file}\0${item.line}`;

// `changedPaths` scopes native analysis to the reviewed change. Undefined or invalid
// means the change is unknown, so native analysis keeps its whole-repository scope.
export async function scanRepository({ root, collect = trackedSources, changedPaths, nativeExecute, nativeHost, env = process.env, now = Date.now }) {
  const started = now();
  try {
    const sources = collect(root), config = configuration(root);
    // A configured `.C` or `.M` is read in the language its standard declares.
    const declared = declaredLanguages(config.native);
    const findings = [];
    let inspectedFiles = 0;
    for (const { file, source } of sources) {
      if (findings.length >= 1000) break; // Already blocked; bound both work and report size.
      findings.push(...sourceFindings(file, source, declared.get(file)).slice(0, 1000 - findings.length));
      inspectedFiles++;
    }
    const changed = Array.isArray(changedPaths) && changedPaths.every(path => typeof path === "string")
      ? new Set(changedPaths) : null;
    // Repository files the compiler read outside the policy scan get its rules too, and
    // the analyzer's suppress attribute is also looked for after macro expansion.
    const dependencyFindings = [];
    const outcomes = await analyzeNative(root, sources, config.native, nativeExecute,
      { host: nativeHost, env, now, changed, findings: dependencyFindings });
    // The expansion pass can report a line a policy rule already reported.
    const reported = new Set(findings.map(findingKey));
    findings.push(...dependencyFindings.filter(item => !reported.has(findingKey(item))).slice(0, Math.max(0, 1000 - findings.length)));
    // A header the probe showed to need Objective-C was not analyzed; it is coverage, not a check.
    const native = outcomes.filter(item => item.rule !== "native.not-analyzed");
    const notAnalyzed = outcomes.filter(item => item.rule === "native.not-analyzed").map(item => item.file);
    const web = checkWebContracts(config.web);
    const checks = [...native, ...web];
    const status = checks.some(check => check.status === "error") ? "error"
      : findings.length || checks.some(check => check.status === "failed") ? "failed" : "passed";
    return { tool: "Praesidium", version: 1, status, findings, checks,
      coverage: { sourceFiles: sources.length, policyInspectedFiles: inspectedFiles,
        findingsLimited: findings.length >= 1000 || findings.some(item => item.rule === "inspection.finding-limit"),
        nativeUnits: native.filter(item => item.file).length, nativeScope: changed ? "changed" : "repository",
        // Objective-C/C++ the host was not configured to compile: policy-scanned, never analyzed.
        nativeNotAnalyzed: [...unanalyzedPlatformUnits(sources, config.native, changed), ...notAnalyzed],
        webContracts: web.length, webRuntimeWiring: "not-verified", scope: "tracked and nonignored new source files; submodules and unsupported languages are not analyzed" },
      durationMs: Math.max(0, now() - started) };
  } catch (error) {
    // Never retain source text, compiler output or parser messages containing secrets. A
    // configuration error names only praesidium.json entries, so it may be shown.
    return { tool: "Praesidium", version: 1, status: "error", findings: [], checks: [],
      reason: error instanceof NativeConfigurationError ? `inspection incomplete: ${error.message}`
        : "inspection incomplete: check repository files, limits and praesidium.json",
      durationMs: Math.max(0, now() - started) };
  }
}
