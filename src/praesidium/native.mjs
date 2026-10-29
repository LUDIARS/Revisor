/** @implements RV-PRAESIDIUM-03 — compiler analysis only; never execute the output. */
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { containedFile } from "./files.mjs";
import { nativePackageIncludes, readNativeHost } from "./native-host.mjs";
import { analyzeNativeBatch } from "./native-batch.mjs";
import { NATIVE_COMPILER_TIMEOUT_MS } from "./native-limits.mjs";
import { contract } from '../contract-runtime.mjs'; /* augur-inject:import:3b9e1c42 */
import augurContract_5d2a8f17 from '../../contracts/analyze-native-changed-scope.contract.mjs'; /* augur-inject:contract-predicate:5d2a8f17 */

export function analyzeProcess(command, args, cwd) {
  return new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8", windowsHide: true, shell: false,
      timeout: NATIVE_COMPILER_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: !error, exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
        diagnostics: /\b(?:warning|error):/.test(`${stdout}\n${stderr}`) });
    });
  });
}

const UNIT_KEYS = ["file", "standard", "includes", "defines", "packages"];
const DEFINE = /^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_]+)?$/;

/** Validate a unit's declared shape without touching the filesystem or host. */
export function validateNativeUnit(unit) {
  if (!unit || Object.keys(unit).some(key => !UNIT_KEYS.includes(key))) throw new Error("invalid native unit");
  const c = /\.c$/i.test(unit.file ?? "");
  if (!/\.(?:c|cc|cpp|cxx)$/i.test(unit.file ?? "")) throw new Error("translation unit required");
  if (!(c ? ["c11", "c17", "c23"] : ["c++17", "c++20", "c++23"]).includes(unit.standard)) throw new Error("explicit supported standard required");
  if (!Array.isArray(unit.includes ?? []) || !Array.isArray(unit.defines ?? []) || !Array.isArray(unit.packages ?? [])) throw new Error("invalid native options");
  if ((unit.includes ?? []).some(include => typeof include !== "string" || isAbsolute(include))) throw new Error("relative include required");
  if ((unit.defines ?? []).some(define => typeof define !== "string" || !DEFINE.test(define))) throw new Error("invalid define");
  return c;
}

export function nativeInvocation(root, unit, host = {}) {
  const c = validateNativeUnit(unit);
  const file = containedFile(root, unit.file);
  const args = ["--analyze", "-Xanalyzer", "-analyzer-output=text", "-Xanalyzer", "-analyzer-checker=core,unix,security",
    "-Wall", "-Wextra", "-Werror", `-std=${unit.standard}`];
  for (const include of unit.includes ?? []) {
    const path = realpathSync(resolve(root, include));
    const rel = relative(realpathSync(root), path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || !statSync(path).isDirectory()) throw new Error("include escapes repository");
    args.push("-I", path);
  }
  for (const define of unit.defines ?? []) args.push(`-D${define}`);
  for (const include of nativePackageIncludes(unit.packages ?? [], host)) args.push("-I", include);
  args.push("--", file);
  return { command: host.compilers?.[c ? "c" : "cpp"] ?? (c ? "clang" : "clang++"), args, cwd: root };
}

/**
 * `options.changed` (a Set of paths changed by the reviewed PR) scopes configuration and
 * compilation to changed translation units. Without it every tracked unit is in scope,
 * which is also the fail-closed fallback when the changed set cannot be computed.
 */
export async function analyzeNative(root, sources, units = [], execute = analyzeProcess, options = {}) {
  const changed = options.changed instanceof Set ? options.changed : null;
  const inScope = file => !changed || changed.has(file);
  const nativeFiles = sources.filter(({ file }) => /\.(?:c|cc|cpp|cxx)$/i.test(file)).map(({ file }) => file);
  const headers = sources.some(({ file }) => /\.(?:h|hh|hpp|hxx)$/i.test(file) && inScope(file));
  if (!Array.isArray(units)) throw new Error("invalid native configuration");
  if (nativeFiles.some(file => inScope(file) && !units.some(unit => unit.file === file)) || (headers && units.length === 0)) {
    return [{ rule: "native.configuration-required", status: "error" }];
  }
  if (new Set(units.map(unit => unit.file)).size !== units.length) throw new Error("duplicate native unit");
  for (const unit of units) {
    validateNativeUnit(unit);
    if (!nativeFiles.includes(unit.file)) throw new Error("untracked translation unit");
  }
  const selected = units.filter(unit => inScope(unit.file));
  if (selected.length > 256) throw new Error("native analysis unit limit");
  if (!selected.length) return [];
  const host = options.host ?? readNativeHost(root, options.env);
  // Validate every invocation before any compiler starts, so a later invalid unit cannot orphan workers.
  const invocations = selected.map(unit => ({ ...nativeInvocation(root, unit, host), file: unit.file }));
  return analyzeNativeBatch(invocations, execute, options.now);
}
// @ts-expect-error augur-inject
analyzeNative = contract(analyzeNative, { ...augurContract_5d2a8f17, contractId: 'C-19', mode: 'observe', sample: 1, where: 'src/praesidium/native.mjs:59', rule: 'contract-wrap', id: '5d2a8f17' }); /* augur-inject:contract-wrap:5d2a8f17 */
