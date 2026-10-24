/** @implements RV-PRAESIDIUM-03 — compiler analysis only; never execute the output. */
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { containedFile } from "./files.mjs";

export function analyzeProcess(command, args, cwd) {
  return new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8", windowsHide: true, shell: false,
      timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: !error, exitCode: typeof error?.code === "number" ? error.code : error ? null : 0,
        diagnostics: /\b(?:warning|error):/.test(`${stdout}\n${stderr}`) });
    });
  });
}

export function nativeInvocation(root, unit) {
  if (!unit || Object.keys(unit).some(key => !["file", "standard", "includes", "defines"].includes(key))) throw new Error("invalid native unit");
  const c = /\.c$/i.test(unit.file ?? "");
  if (!/\.(?:c|cc|cpp|cxx)$/i.test(unit.file ?? "")) throw new Error("translation unit required");
  if (!(c ? ["c11", "c17", "c23"] : ["c++17", "c++20", "c++23"]).includes(unit.standard)) throw new Error("explicit supported standard required");
  const file = containedFile(root, unit.file);
  const args = ["--analyze", "-Xanalyzer", "-analyzer-output=text", "-Xanalyzer", "-analyzer-checker=core,unix,security",
    "-Wall", "-Wextra", "-Werror", `-std=${unit.standard}`];
  if (!Array.isArray(unit.includes ?? []) || !Array.isArray(unit.defines ?? [])) throw new Error("invalid native options");
  for (const include of unit.includes ?? []) {
    if (typeof include !== "string" || isAbsolute(include)) throw new Error("relative include required");
    const path = realpathSync(resolve(root, include));
    const rel = relative(realpathSync(root), path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || !statSync(path).isDirectory()) throw new Error("include escapes repository");
    args.push("-I", path);
  }
  for (const define of unit.defines ?? []) {
    if (typeof define !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_]+)?$/.test(define)) throw new Error("invalid define");
    args.push(`-D${define}`);
  }
  args.push("--", file);
  return { command: c ? "clang" : "clang++", args, cwd: root };
}

export async function analyzeNative(root, sources, units = [], execute = analyzeProcess) {
  const startedAt = Date.now();
  const nativeFiles = sources.filter(({ file }) => /\.(?:c|cc|cpp|cxx)$/i.test(file)).map(({ file }) => file);
  const headers = sources.some(({ file }) => /\.(?:h|hh|hpp|hxx)$/i.test(file));
  if (!Array.isArray(units) || units.length > 256) throw new Error("invalid native configuration");
  if (nativeFiles.some(file => !units.some(unit => unit.file === file)) || (headers && units.length === 0)) {
    return [{ rule: "native.configuration-required", status: "error" }];
  }
  if (new Set(units.map(unit => unit.file)).size !== units.length) throw new Error("duplicate native unit");
  const outcomes = [];
  for (const unit of units) {
    if (Date.now() - startedAt > 120_000) {
      outcomes.push({ rule: "native.analysis-budget", status: "error" });
      break;
    }
    if (!nativeFiles.includes(unit.file)) throw new Error("untracked translation unit");
    const invocation = nativeInvocation(root, unit);
    const result = await execute(invocation.command, invocation.args, invocation.cwd);
    outcomes.push({ rule: "native.clang-analysis", file: unit.file,
      status: result.ok && !result.diagnostics ? "passed" : result.exitCode === null ? "error" : "failed" });
  }
  return outcomes;
}
