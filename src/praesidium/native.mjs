/** @implements RV-PRAESIDIUM-03 — compiler analysis only; never execute the output. */
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { containedFile, repositoryFiles } from "./files.mjs";
import { isCLanguageUnit, isModuleUnit, isNativeFragment, isNativeHeader, isNativeSource, isPlatformUnit,
  isTranslationUnit, isEitherLanguageUnit, unitLanguage } from "./languages.mjs";
import { NATIVE_WARNINGS, nativeBaselineArguments } from "./native-baseline.mjs";
import { NATIVE_REJECTED_APIS } from "./rules.mjs";
import { maskNativeCode } from "./native-lexer.mjs";
import { nativePackageIncludes, readNativeHost } from "./native-host.mjs";
import { analyzeNativeBatch } from "./native-batch.mjs";
import { NATIVE_COMPILER_TIMEOUT_MS } from "./native-limits.mjs";
import { EXPANSION_LIMIT, expandedSuppressions, expansionLexing, holdsObjectiveC } from "./native-expansion.mjs";
import { DEPENDENCY_TARGET, dependencyFindings, readDependencyList, repositoryFile } from "./native-dependencies.mjs";
export { dependencyList } from "./native-dependencies.mjs";
import { contract } from '../contract-runtime.mjs'; /* augur-inject:import:3b9e1c42 */
import augurContract_5d2a8f17 from '../../contracts/analyze-native-changed-scope.contract.mjs'; /* augur-inject:contract-predicate:5d2a8f17 */

// The most files one inspection analyzes: units, header jobs and the units compiled for
// changed fragments and other included files.
const UNIT_LIMIT = 256;

// A compiler that crashed inspected nothing: its driver still exits with a number, so the
// crash is reported as an incomplete check (error), not as a finding about the unit.
const COMPILER_CRASH = /\bfrontend command failed\b|\bPLEASE submit a bug report\b/;

function optionalDependencyList(path) {
  try { return readDependencyList(path); } catch { return undefined; }
}

export function analyzeProcess(command, args, cwd) {
  // The expansion pass and the probe print the preprocessed file, which is read, never
  // shown; the probe's has no linemarkers (`-P`).
  const preprocessed = args.includes("-E");
  const probe = preprocessed && args.includes("-P"), expansion = preprocessed && !probe;
  return new Promise((done) => {
    execFile(command, args, { cwd, encoding: preprocessed ? "latin1" : "utf8", windowsHide: true, shell: false,
      timeout: NATIVE_COMPILER_TIMEOUT_MS, maxBuffer: preprocessed ? EXPANSION_LIMIT : 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = preprocessed ? stderr : `${stdout}\n${stderr}`;
      const exitCode = typeof error?.code === "number" && !COMPILER_CRASH.test(output) ? error.code : error ? null : 0;
      const result = { ok: !error, exitCode, diagnostics: /\b(?:warning|error):/.test(output) };
      // A pass that passed must say what it read; if it cannot, the inspection is incomplete.
      // clang also lists what a failing pass read, which then only adds findings.
      const list = args.indexOf("-MF");
      const passed = result.ok && !result.diagnostics;
      try {
        if (list >= 0 && passed) result.dependencies = readDependencyList(args[list + 1]);
        else if (list >= 0 && exitCode !== null) result.dependencies = optionalDependencyList(args[list + 1]);
        if (expansion && result.ok) {
          result.suppressions = expandedSuppressions(stdout, expansionLexing(args));
          result.diagnostics ||= result.suppressions.length > 0;
        }
        if (probe && result.ok) result.diagnostics ||= holdsObjectiveC(stdout, expansionLexing(args));
      } catch { done({ ok: false, exitCode: null }); return; }
      done(result);
    });
  });
}

const UNIT_KEYS = ["file", "standard", "includes", "defines", "packages"];
const DEFINE = /^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_]+)?$/;
// `cplusplus` (NewDelete, Move, InnerPointer, ...) is also a driver default; naming it keeps
// it if the defaults change. The two opt-in C++ checkers report fields a constructor
// leaves uninitialized and virtual calls during construction or destruction; both exist
// since clang 8 and raised nothing on Odeum's 70 package-free units. Alpha checkers stay
// off: their names change between releases (an unknown name fails every unit) and they
// are not stable enough to block merges.
const NATIVE_CHECKERS = "core,cplusplus,unix,security,optin.cplusplus.UninitializedObject,optin.cplusplus.VirtualCall";
// In C the first checker reports every snprintf, vsnprintf, memcpy, memmove and memset
// (C11 Annex K advice), which leaves a C unit no accepted way to format or copy. The
// unbounded APIs it is meant for are rejected by the policy rule and the baseline already.
// The second ends every path at a call to a global C function with one of a fixed list of
// names (`exit`, `panic`, `error`, `Assert`, ...) whether or not the callee returns, so
// glibc's returning `error(0, ...)` or a repository function named `panic` that returns hid
// every report after it (a method named `error` is not on the list). Functions declared
// noreturn (`_Noreturn`, `[[noreturn]]`, exit, abort, the C libraries' assert handlers)
// still end paths without it; a glibc `error(EXIT_FAILURE, ...)` guard no longer does, so
// the code after it must end the path itself. Windows keeps it: the UCRT's assert handler
// `_wassert` is not declared noreturn, so without the list every assert would let the
// path it guards continue.
const NATIVE_DISABLED_CHECKERS = ["security.insecureAPI.DeprecatedOrUnsafeBufferHandling",
  ...(process.platform === "win32" ? [] : ["core.builtin.NoReturnFunctions"])].join(",");
// Declared standard -> clang spelling. clang 17 knows C++26 only as `c++2c`.
const STANDARDS = new Map([["c11", "c11"], ["c17", "c17"], ["c23", "c23"],
  ["c++17", "c++17"], ["c++20", "c++20"], ["c++23", "c++23"], ["c++26", "c++2c"]]);
const C_STANDARDS = ["c11", "c17", "c23"];
// Whether a configured unit is compiled as C or Objective-C: a `.C` or `.M` by its declared
// standard, any other file by its extension.
const isCUnit = unit => isEitherLanguageUnit(unit.file) ? C_STANDARDS.includes(unit.standard) : isCLanguageUnit(unit.file);

/**
 * The language each configured `.C` or `.M` unit declares by its standard (true for C,
 * false for C++), by file, for what otherwise knows such a file only by its name: the
 * policy readings and the includer index. An entry that is not such a unit with a
 * supported standard is left out (validateNativeUnit rejects it), so its file still counts
 * as both languages.
 */
export function declaredLanguages(units) {
  const declared = new Map();
  for (const unit of Array.isArray(units) ? units : []) {
    if (typeof unit?.file === "string" && isEitherLanguageUnit(unit.file) && STANDARDS.has(unit.standard)) {
      declared.set(unit.file, C_STANDARDS.includes(unit.standard));
    }
  }
  return declared;
}
// A reviewed repository must not switch off what its own analysis relies on: the
// analyzer's identity, the Praesidium baseline, or the names of APIs the policy rejects
// (a macro could rename them out of the baseline). The baseline is read before any unit
// code, so only a definition can reach it: `_WIN32` skips it, an attribute spelling turns
// its deprecation into another attribute (`deprecated=nodiscard`), and the other names
// it spells would change its declarations. Hardening macros are the product build's own
// choice (AIFormat RULE_CODE_CPP §C2.9, §C2.10 copies a build's defines into
// praesidium.json) and are compiled as written, like any other reserved name
// (`__STDC_FORMAT_MACROS`).
const CONTROL_DEFINE = new RegExp(`^(?:__clang_analyzer__|PRAESIDIUM_[A-Za-z0-9_]*|${["_WIN32", "__cplusplus", "__has_include",
  "deprecated", "__deprecated__", "__attribute__", "__restrict", "__builtin_va_list", "__WCHAR_TYPE__", "wchar_t",
  "noexcept", "std"].join("|")})$`);
// _FORTIFY_SOURCE acts only in optimized builds. Analysis never optimizes, and glibc turns
// the define into a #warning there, so a product's value is accepted and not passed on.
const IGNORED_DEFINE = /^_FORTIFY_SOURCE(?:=[A-Za-z0-9_]+)?$/;

// A configuration problem whose description holds only praesidium.json names (a unit's
// path and a macro name), never source text, so the report may show it.
export class NativeConfigurationError extends Error {}

/** Validate a unit's declared shape without touching the filesystem or host. */
export function validateNativeUnit(unit) {
  if (!unit || Object.keys(unit).some(key => !UNIT_KEYS.includes(key))) throw new Error("invalid native unit");
  if (!isTranslationUnit(unit.file)) throw new Error("translation unit required");
  const c = isCUnit(unit);
  if (!STANDARDS.has(unit.standard) || C_STANDARDS.includes(unit.standard) !== c) throw new Error("explicit supported standard required");
  if (!Array.isArray(unit.includes ?? []) || !Array.isArray(unit.defines ?? []) || !Array.isArray(unit.packages ?? [])) throw new Error("invalid native options");
  if ((unit.includes ?? []).some(include => typeof include !== "string" || isAbsolute(include))) throw new Error("relative include required");
  if ((unit.defines ?? []).some(define => typeof define !== "string" || !DEFINE.test(define))) throw new Error("invalid define");
  for (const define of unit.defines ?? []) {
    const name = define.split("=")[0];
    if (CONTROL_DEFINE.test(name) || NATIVE_REJECTED_APIS.includes(name)) {
      throw new NativeConfigurationError(`${unit.file}: define ${name} overrides analysis controls`);
    }
  }
  return c;
}

/**
 * The clang driver adds `-w` to every `--analyze` job, so compiler warnings (and
 * `-Werror`) never surface from the analyzer. Each unit therefore runs bounded passes
 * with the same language, standard, includes and definitions: a diagnostics pass with
 * the strict warning set, an expansion pass, then the static analyzer. All must pass.
 *
 * With `header`, the unit's configuration analyzes that header as the main file
 * instead: the analyzer only path-analyzes functions defined in the main file, so
 * inline and in-class code in a header is otherwise checked only where a unit calls it.
 * The diagnostics pass uses the header language (no `#pragma once` or unused-static
 * noise, and `-fsyntax-only` writes no PCH); the analyzer pass must not, because an
 * analyzer job for a header language writes a PCH into the reviewed repository.
 *
 * The expansion pass prints the file preprocessed (`-E`, to the process's output, never
 * to disk), where the analyzer's suppress attribute is found however the source reaches
 * it (native-expansion.mjs). Nothing is defined for analysis that the product build
 * lacks, so no condition can tell the two apart by a macro.
 *
 * `options.dependencies` makes the diagnostics pass list the files it read there.
 * `options.probe` adds a first pass that only preprocesses the header (`-E -P -w`) and
 * asks whether the unit's compiler can read it as C or C++ at all: every include and
 * import resolves, no `#error` fires, and no `@` (Objective-C syntax) stands outside a
 * literal in what it read (an Objective-C-looking header, see headerJobs). It also adds
 * `syntax`, two checks that only parse the header without warnings (`-fsyntax-only -w`):
 * in the unit's language, then as Objective-C with blocks. When the diagnostics pass
 * fails, they tell Objective-C syntax without an `@` (a message send, a block) from a
 * defect (native-batch.mjs).
 */
export function nativeInvocation(root, unit, host = {}, header = null, options = {}) {
  const c = validateNativeUnit(unit);
  if (header !== null && !isNativeHeader(header)) throw new Error("header required");
  const file = containedFile(root, header ?? unit.file);
  const language = unitLanguage(unit.file, c);
  // A crashing clang otherwise writes the preprocessed unit, with every header's text,
  // to a world-readable reproducer in the temporary directory.
  const shared = ["-fno-crash-diagnostics", `-std=${STANDARDS.get(unit.standard)}`];
  for (const include of unit.includes ?? []) {
    const path = realpathSync(resolve(root, include));
    const rel = relative(realpathSync(root), path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || !statSync(path).isDirectory()) throw new Error("include escapes repository");
    shared.push("-I", path);
  }
  for (const define of unit.defines ?? []) if (!IGNORED_DEFINE.test(define)) shared.push(`-D${define}`);
  // Host libraries are trusted toolchain inputs like SDK headers: their own warnings are
  // not the reviewed change's, while analyzer reports reached from repository code remain.
  for (const include of nativePackageIncludes(unit.packages ?? [], host)) shared.push("-isystem", include);
  shared.push(...nativeBaselineArguments({ module: header === null && isModuleUnit(unit.file) }));
  const mainLanguage = header === null ? language : `${language}-header`;
  const objectiveC = `objective-${c ? "c" : "c++"}-header`;
  const diagnostics = ["-fsyntax-only", ...NATIVE_WARNINGS, ...(header === null ? [] : ["-Wno-unused-function"]),
    ...(options.dependencies ? ["-MD", "-MF", options.dependencies, "-MT", DEPENDENCY_TARGET] : []), "-x", mainLanguage];
  return {
    command: host.compilers?.[c ? "c" : "cpp"] ?? (c ? "clang" : "clang++"),
    cwd: root,
    ...(options.probe ? { syntax: [["-fsyntax-only", "-w", "-x", mainLanguage, ...shared, "--", file],
      ["-fsyntax-only", "-w", "-fblocks", "-x", objectiveC, ...shared, "--", file]] } : {}),
    passes: [
      ...(options.probe ? [["-E", "-P", "-w", "-x", mainLanguage, ...shared, "--", file]] : []),
      [...diagnostics, ...shared, "--", file],
      ["-E", "-w", "-x", mainLanguage, ...shared, "--", file],
      // The analyzer defines __clang_analyzer__; undefining it makes the analyzer read the
      // code the compiler builds, so no condition on that macro (pasted or not) can show it
      // different code.
      ["--analyze", "-Xanalyzer", "-analyzer-output=text", "-Xanalyzer", `-analyzer-checker=${NATIVE_CHECKERS}`,
        "-Xanalyzer", `-analyzer-disable-checker=${NATIVE_DISABLED_CHECKERS}`, "-U__clang_analyzer__",
        "-x", language, ...shared, "--", file],
    ],
  };
}

// A relative path's components with `.` and `..` resolved, as posix.normalize resolves
// them, and the levels it first climbs counted apart (`up`): one pass over the path, where
// posix.normalize reads its result again at each leading `..` (quadratic in a long climb).
function pathParts(path) {
  const parts = [];
  let up = 0;
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length) parts.pop();
    else up++;
  }
  return { up, parts };
}

function repositoryPath(path) {
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/")) return posix.normalize(slashed).replace(/\/$/, "");
  const { up, parts } = pathParts(slashed);
  return [...Array(up).fill(".."), ...parts].join("/") || ".";
}

const OBJECTIVE_C_HEADER = /^[ \t]*#[ \t]*import\b|@(?:interface|protocol|implementation|class)\b/m;
const CXX_ONLY_HEADER = /\b(?:namespace|template|class|static_cast|reinterpret_cast)\b|::/;
// Valid in C23 as well as C++: they prefer a C++ unit and fall back to a C one.
const C23_OR_CXX_HEADER = /\b(?:constexpr|nullptr)\b/;
// A C23 or C++ attribute: `[[gnu::always_inline]]` is valid C23, so its `::` is not C++.
const ATTRIBUTE = /\[\[[^[\]]*\]\]/g;
// The preprocessor ends a line, and so a directive, at LF, CR LF or a lone CR; the masked
// view keeps each of them.
const LINE_END = /\r\n?|\n/;
// The head of a directive line in the masked logical view: blanks, `#`, blanks, then the
// name (empty for a null directive). It is read anchored at the line's start and the rest
// of the line is sliced off after it, so no two quantifiers compete for one character.
const DIRECTIVE_HEAD = /^[ \t]*#[ \t]*(\w*)/;
const FIRST_WORD = /^[ \t]*(\w*)/;
const CONDITIONALS = new Set(["if", "ifdef", "ifndef", "elif", "elifdef", "elifndef", "else", "endif"]);
// `#if !defined(X)` or `#if !defined X`, the other spelling of an include guard's opening.
const GUARD_CONDITION = /^\s*!\s*defined(?:\s*\(\s*([A-Za-z_]\w*)\s*\)|\s+([A-Za-z_]\w*))\s*$/;
const CPLUSPLUS = /\b__cplusplus\b/;
const CXX_MACRO = String.raw`(?:defined\s*\(\s*__cplusplus\s*\)|defined\s+__cplusplus|__cplusplus)`;
// `#if __cplusplus`, `defined(__cplusplus) && ...` or `__cplusplus >= 201103L`: only C++
// takes the group. Its #else is C only when the condition was the plain test.
const CXX_CONDITION = new RegExp(String.raw`^\s*(!\s*)?${CXX_MACRO}\s*((?:&&|(?:>=|>|==)\s*\d+L?\b).*)?$`);
// C++ linkage in the masked view (the "C" is blank): `extern "C" {` (also across lines),
// `extern "C"` before one declaration, and `}`. A `{` of its own opens a block, not linkage.
const CXX_LINKAGE = /\bextern\s*"\s*"(?:\s*\{)?|\}/g;
// Directives that change what the code after them reads: an include (`#embed` included),
// a removed definition, or the line and file `__LINE__` and `__FILE__` give (`#line`, or a
// GNU line marker `# 12 "a.h"`, whose name is a number). Definitions are read on their own.
const LANGUAGE_DIRECTIVES = new Set(["undef", "include", "include_next", "import", "embed", "line"]);
// Pragmas that do the same: `push_macro` and `pop_macro` save and restore a definition,
// `include_alias` renames an include, and clang's module pragmas import a module's macros.
const LANGUAGE_PRAGMA = /^[ \t]*(?:push_macro|pop_macro|include_alias|clang[ \t]+module)\b/;
// The name and parameter list at the start of a definition; the body follows them.
const DEFINED_NAME = /^[ \t]*([A-Za-z_]\w*)(?:\([^)]*\))?/;
// What linkagePlaced reads in the code C reads, one token at a time: braces and
// parentheses, the digraph and trigraph spellings of a brace (`<%`, `%>`, `??<`, `??>`, and
// `<%:`, which the masked view shows as `<#`), where it gives up rather than count them,
// names, numbers and any other character but a blank.
const SCOPE_TOKEN = /<[ \t]*[%#]|%[ \t]*>|\?\?[<>]|[A-Za-z_]\w*|\d\w*|\S/g;
const BRACE_SPELLING = /^(?:<[ \t]*[%#]|%[ \t]*>|\?\?[<>])$/;
// The `(` that makes a function-like macro's name a use of it, read from the name's end.
const CALL_OPEN = /[ \t]*\(/y;

function cxxGroup(directive, argument) {
  if (directive === "ifdef" || directive === "ifndef") {
    if (argument.trim() !== "__cplusplus") return { taken: null, other: null };
    return directive === "ifdef" ? { taken: "c++", other: "c" } : { taken: "c", other: "c++" };
  }
  const match = CXX_CONDITION.exec(argument);
  if (!match || (match[1] && match[2])) return { taken: null, other: null };
  const [taken, other] = match[1] ? ["c", "c++"] : ["c++", "c"];
  return { taken, other: match[2] ? null : other };
}

// A directive line's name and the text after it, or null for a line of code.
function directiveOf(line) {
  const head = line.includes("#") ? DIRECTIVE_HEAD.exec(line) : null;
  return head ? { name: head[1], rest: line.slice(head[0].length) } : null;
}

// A conditional directive (`#if` ... `#endif`), or null.
function conditionalOf(line) {
  const directive = directiveOf(line);
  return directive && CONDITIONALS.has(directive.name) ? directive : null;
}

// A directive with a name (not a null directive), or null.
function namedDirectiveOf(line) {
  const directive = directiveOf(line);
  return directive?.name ? directive : null;
}

/**
 * A header's masked logical text split into lines (a lone CR, CR LF or LF ends one) and
 * the language that takes each line (`taken`): "c++" in the groups only C++ takes (by
 * their `__cplusplus` test), "c" in the groups only C takes, null elsewhere, undefined on
 * a conditional directive. `dead` marks the lines no compiler reads: a group of `#if 0` or
 * `#elif 0`, with the groups inside it. `branch` holds, for each conditional directive
 * outside those, what it starts: its kind ("if", "elif", "else" or "endif"), the language that
 * takes the group after it ("dead" for `#if 0`), and for an "if" the language of the
 * missing `#else` ("guard" for a whole-file include guard); `grouped` marks the lines inside
 * a group other than that guard. Also two views: the code outside every conditional group
 * (a whole-file include guard does not count) and the code a C compiler can read (outside
 * the C++ groups); and `otherTests` when `__cplusplus` also appears anywhere else a
 * compiler reads (an `#elif`, a condition such as `|| defined(X)`, code, a definition such
 * as `#define IS_CXX __cplusplus`). One pass with constant work per line, so it stays linear.
 */
function conditionalViews(code) {
  const lines = code.includes("\r") ? code.split(LINE_END) : code.split("\n");
  const guard = includeGuard(lines);
  const unconditional = [], c = [], taken = [], stack = [];
  const dead = new Uint8Array(lines.length), grouped = new Uint8Array(lines.length), branch = new Array(lines.length);
  let open = 0; // groups on the stack other than the include guard
  let otherTests = false;
  const language = () => stack.at(-1)?.language ?? null;
  const deadHere = () => stack.length > 0 && (stack.at(-1).outerDead || stack.at(-1).dead);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const conditional = conditionalOf(line);
    taken.push(conditional ? undefined : language());
    if (!line) continue; // an empty line changes no view
    dead[index] = deadHere() ? 1 : 0;
    grouped[index] = open > 0 ? 1 : 0;
    if (!conditional) {
      if (open === 0) unconditional.push(line);
      if (taken[index] !== "c++") c.push(line);
      otherTests ||= !dead[index] && CPLUSPLUS.test(line);
      continue;
    }
    const { name: directive, rest: argument } = conditional;
    const group = stack.at(-1);
    if (directive.startsWith("if")) {
      otherTests ||= !dead[index] && CPLUSPLUS.test(argument) && cxxGroup(directive, argument).taken === null;
      const inherited = language();
      const { taken: only, other } = cxxGroup(directive, argument);
      const entry = { guard: index === guard, language: only ?? inherited, other: other ?? inherited, inherited,
        outerDead: dead[index], dead: directive === "if" && argument.trim() === "0" };
      stack.push(entry);
      if (index !== guard) open++;
      if (!dead[index]) branch[index] = branchOf("if", entry.dead ? "dead" : entry.language, entry.guard ? "guard" : entry.other);
      continue;
    }
    dead[index] = group?.outerDead ? 1 : 0;
    otherTests ||= !dead[index] && CPLUSPLUS.test(argument);
    if (!group) continue;
    if (directive === "endif") {
      if (!group.guard) open--;
      stack.pop();
      if (!dead[index]) branch[index] = branchOf("endif");
      continue;
    }
    if (group.guard) { group.guard = false; open++; }
    group.language = group.other ?? group.inherited;
    group.dead = directive === "elif" && argument.trim() === "0";
    if (!dead[index]) branch[index] = branchOf(directive === "else" ? "else" : "elif", group.dead ? "dead" : group.language);
  }
  return { lines, taken, dead, grouped, branch, unconditional: unconditional.join("\n"), c: c.join("\n"), otherTests };
}

// One shared record per kind of branch (a hundred at most), so no line allocates one.
const BRANCH_KINDS = ["if", "else", "elif", "endif"], BRANCH_LANGUAGES = [null, "c", "c++", "dead", "guard"];
const BRANCHES = BRANCH_KINDS.flatMap(kind => BRANCH_LANGUAGES.flatMap(language => BRANCH_LANGUAGES.map(otherwise =>
  Object.freeze({ kind, language, otherwise }))));
const branchOf = (kind, language = null, otherwise = null) => BRANCHES[(BRANCH_KINDS.indexOf(kind) * 5
  + BRANCH_LANGUAGES.indexOf(language)) * 5 + BRANCH_LANGUAGES.indexOf(otherwise)];

// The line of a whole-file include guard: the first conditional directive is `#ifndef X`
// (or `#if !defined(X)`), the next directive `#define X`, no code precedes it and none
// follows its `#endif`. Otherwise -1: a group with code outside it is an ordinary
// condition (`#ifndef _MSC_VER` can hide a marker from one compiler only). Linear: each
// line is read at most twice.
function includeGuard(lines) {
  const start = lines.findIndex(line => conditionalOf(line) || (line.trim() && !namedDirectiveOf(line)));
  const opening = start < 0 ? null : conditionalOf(lines[start]);
  const name = opening ? guardName(opening.name, opening.rest) : null;
  if (!name) return -1;
  const next = lines.findIndex((line, index) => index > start && namedDirectiveOf(line));
  const define = next < 0 ? null : namedDirectiveOf(lines[next]);
  if (define?.name !== "define" || FIRST_WORD.exec(define.rest)[1] !== name) return -1;
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    const directive = conditionalOf(lines[index])?.name;
    if (!directive) continue;
    if (directive.startsWith("if")) depth++;
    else if (directive === "endif" && --depth === 0) {
      return lines.slice(index + 1).every(line => !line.trim()) ? start : -1;
    }
  }
  return -1;
}

// The macro a guard's opening directive tests for being undefined, or null.
function guardName(directive, argument) {
  if (directive === "ifndef") return argument.trim() || null;
  return directive === "if" ? (GUARD_CONDITION.exec(argument)?.slice(1).find(Boolean) ?? null) : null;
}

/**
 * The languages a header is written for, from its masked logical text: "objective-c"
 * when it imports or declares Objective-C outside every conditional group; "c++" for
 * a C++ extension or C++-only spellings in the code a C compiler would read; for a `.h`
 * that tests `__cplusplus`, "c-linkage" when it does so only in plain group conditions
 * and C++ reads the code C reads, only inside C++ linkage (sameReading: a C header that
 * C++ may include), else "c-and-c++" (written for both); "c23-or-c++" for spellings both
 * C23 and C++ have; otherwise either (`null`).
 */
export function headerLanguage(file, source) {
  return codeLanguage(file, maskedHeader(source));
}

const maskedHeader = source => typeof source === "string" ? maskNativeCode(source, { logical: true }) : "";

function codeLanguage(file, code) {
  const views = conditionalViews(code);
  if (OBJECTIVE_C_HEADER.test(views.unconditional)) return "objective-c";
  return portableLanguage(file, code, views);
}

function portableLanguage(file, code, views = conditionalViews(code)) {
  const c = views.c.replace(/@class\b/g, " ").replace(ATTRIBUTE, " ");
  if (!/\.h$/i.test(file) || CXX_ONLY_HEADER.test(c)) return "c++";
  if (CPLUSPLUS.test(code)) return !views.otherTests && sameReading(views) ? "c-linkage" : "c-and-c++";
  return C23_OR_CXX_HEADER.test(c) ? "c23-or-c++" : null;
}

/**
 * Whether C++ reads the code C reads, only inside C++ linkage, from conditionalViews (the
 * lines no compiler reads, `#if 0`, left out): no group of either language holds a
 * directive that can change what the code after it reads (sharedDirective), and when a
 * group holds code or defines a macro (linkage boilerplate,
 * `# define __BEGIN_DECLS extern "C" {`), linkagePlaced holds.
 */
function sameReading(views) {
  const { lines, taken, dead } = views;
  const macros = new Set();
  let code = false;
  for (let index = 0; index < lines.length; index++) {
    const language = taken[index];
    if (!language || dead[index]) continue;
    const directive = directiveOf(lines[index]);
    if (!directive) {
      code ||= lines[index].trim() !== "";
    } else if (!sharedDirective(directive)) {
      return false;
    } else if (directive.name === "define") {
      const defined = DEFINED_NAME.exec(directive.rest);
      if (defined) macros.add(defined[1]);
    }
  }
  return (!code && macros.size === 0) || linkagePlaced(views, macros);
}

/**
 * Whether C++'s own code is linkage where the code C reads has no brace or parenthesis
 * open. Code only C reads (`#ifndef __cplusplus`, the `#else` of `#ifdef __cplusplus`)
 * may stand anywhere: C++ reads the same code less those lines (a member or a check only C
 * has), apart from a pragma operator there (`_Pragma("pop_macro(...)")`, whose text the
 * masked view hides). In one pass over the lines a compiler reads:
 * - each run of C++ group code is linkage (CXX_LINKAGE) where no brace or parenthesis of
 *   the code C reads is open; a second `extern "C" {` would otherwise let a `}` inside a
 *   function move statements out of a block for C++ alone;
 * - each linkage macro (`macros`, and every macro whose body names one: linkageMacros) is
 *   used in code C++ also reads only where linkage may stand (code only C reads is not
 *   checked: C++ reads none of it), and in a directive only as the condition of a group
 *   before the header defines or removes it (freetype's `#ifndef FT_BEGIN_HEADER` around its
 *   definitions); a definition names it only outside braces and parentheses;
 * - braces and parentheses are counted where a macro of the header is used, as many as its
 *   body opens or closes (braceDeltas), and each branch of a group starts from the depth
 *   before it; the branches C may read must end at one depth (a function head split over
 *   `#if`/`#else` shares one `}`), or the next group must repeat the group's conditions and
 *   bring its branches back to one depth (readBranch). The depth cannot be told for a `}`
 *   or `)` with none open (a macro from elsewhere opened it), a digraph or trigraph brace,
 *   or a macro whose braces vary (braceDeltas), and the header then counts as written for
 *   both languages.
 */
function linkagePlaced(views, macros) {
  const { lines, taken, dead, branch } = views;
  const scope = scopeDefinitions(views, macros);
  if (!scope) return false;
  Object.assign(scope, { token: new RegExp(SCOPE_TOKEN), depth: 0, parens: 0, groups: [], split: null, redefined: -1 });
  const run = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], language = taken[index];
    if (dead[index]) continue;
    if (language === "c++") {
      if (line && !directiveOf(line)) run.push(line);
      continue;
    }
    if (run.length && !linkageAt(run, scope)) return false;
    run.length = 0;
    const directive = directiveOf(line);
    if (directive && branch[index]) {
      if (!directiveUses(scope, directive, index, false) || !readBranch(scope, branch[index], directive, index)) return false;
      continue;
    }
    if (!line.trim()) continue;
    // Between a group whose branches end at different depths and the group that repeats
    // its conditions, nothing else may stand (readBranch).
    if (scope.split) return false;
    if (directive) {
      if (!directiveUses(scope, directive, index, language === null)) return false;
      if (redefines(directive)) scope.redefined = index;
      continue;
    }
    if (PRAGMA_OPERATOR.test(line)) {
      if (language === "c") return false;
      scope.redefined = index;
    }
    if (!readScope(scope, line, index, language === "c")) return false;
  }
  return !scope.split && (!run.length || linkageAt(run, scope));
}

// Whether the lines of a run of C++ group code are blank, or linkage where no brace or
// parenthesis of the code C reads is open.
function linkageAt(lines, scope) {
  const code = lines.join("\n");
  return !code.trim() || (scope.depth === 0 && scope.parens === 0 && isLinkage(code));
}
const isLinkage = text => !text.replace(CXX_LINKAGE, " ").trim();

// Directives after which a later condition can compute another value with the same text:
// a definition, its removal, an include, or a pragma that restores or imports definitions.
const REDEFINING = new Set(["define", "undef", "include", "include_next", "import"]);
const redefines = ({ name, rest }) => REDEFINING.has(name) || (name === "pragma" && LANGUAGE_PRAGMA.test(rest));
// The pragma operators, in code: a pragma whose text the masked view hides.
const PRAGMA_OPERATOR = /\b(?:_Pragma|__pragma)\b/;
// Names whose value changes between two tests with the same text.
const MOVING_CONDITION = /\b__(?:LINE|COUNTER)__\b/;
const readByC = language => language !== "c++" && language !== "dead";
const depthOf = ({ depth, parens }) => ({ depth, parens });

/**
 * Reads a conditional directive's branch into the scope. Each branch starts at the depth
 * before the group; when the group ends, the branches C may read (not "c++" or "dead"; the
 * missing `#else` too, unless a guard or C++ alone skips the group) must have ended at one
 * depth, which goes on. When they have not, the depth after the group depends on its
 * branch (`#if USE_INLINE` opening a function body that `#else` only declares), and the
 * next line must open a group that begins with the same conditions (`#if USE_INLINE`
 * holding the rest of the body and its `}`): it takes the same branch, so each of its
 * branches starts where the earlier group's branch ended (a further `#elif` where its
 * `#else` did), and its branches must then end at one depth (or split again for a group
 * after it). Only a group nothing in it can make the next test differ (redefines, a pragma
 * operator or `__LINE__`/`__COUNTER__` in a condition) splits.
 */
function readBranch(scope, { kind, language, otherwise }, { name, rest }, index) {
  const condition = `${name} ${rest.trim().replace(/[ \t]+/g, " ")}`;
  if (kind === "if") {
    const split = scope.split;
    scope.split = null;
    const group = { start: depthOf(scope), starts: split?.ends ?? null, repeats: split?.conditions ?? null, ends: [],
      conditions: [condition], branch: 0, language, otherwise, complete: false, opened: index };
    scope.groups.push(group);
    enterBranch(scope, group);
    return true;
  }
  if (scope.split) return false;
  const group = scope.groups.at(-1);
  if (!group) return true;
  if (readByC(group.language)) group.ends[group.branch] = depthOf(scope);
  if (kind === "endif") {
    scope.groups.pop();
    return endGroup(scope, group);
  }
  group.branch++;
  if (kind === "elif") group.conditions.push(condition);
  else group.complete = true;
  group.language = language;
  enterBranch(scope, group);
  return true;
}

// Starts the group's current branch at its depth: the depth before the group, or where
// the same branch of the group it repeats ended; a branch after that group's conditions
// (a further `#elif`, or the `#else`) lies within that group's `#else`. A branch C did not
// read there (`#elif 0`) has no depth, and C does not read it here either.
function enterBranch(scope, group) {
  const start = group.starts ? group.starts[Math.min(group.branch, group.repeats.length)] : group.start;
  if (start) Object.assign(scope, start);
}

// Ends a group (readBranch): a group that repeats another must begin with its conditions,
// its missing `#else` ends where it starts, and the branches C may read go on at their one
// depth, or split for the next group to repeat.
function endGroup(scope, group) {
  const count = group.conditions.length;
  if (group.repeats?.some((text, at) => text !== group.conditions[at])) return false;
  if (!group.complete && readByC(group.otherwise) && group.otherwise !== "guard") {
    group.branch = count;
    group.language = group.otherwise;
    enterBranch(scope, group);
    group.ends[count] = depthOf(scope);
  }
  const ends = group.ends.filter(Boolean);
  Object.assign(scope, ends[0] ?? group.start);
  if (ends.every(end => end.depth === ends[0].depth && end.parens === ends[0].parens)) return true;
  if (scope.redefined > group.opened || group.conditions.some(text => MOVING_CONDITION.test(text))) return false;
  scope.split = { conditions: group.conditions, ends: group.ends };
  return true;
}

// Whether a directive C may read names a linkage macro only where it may: as the defined
// name or in the body of a definition outside the groups (scopeDefinitions checked the
// body), and in a condition before the header first defines or removes it.
function directiveUses(scope, { name, rest }, index, shared) {
  let names = rest;
  if (name === "define") {
    const defined = DEFINED_NAME.exec(rest);
    if (!defined) return true;
    if (shared && scope.groupMacros.has(defined[1])) return false;
    names = "";
  }
  const conditional = CONDITIONALS.has(name);
  for (const [word] of names.matchAll(/[A-Za-z_]\w*/g)) {
    if (scope.linkage.has(word) && !(conditional && index < (scope.first.get(word) ?? Infinity))) return false;
  }
  return true;
}

// Reads one line of the code C reads into the scope: the depth of its braces and
// parentheses, as written and as the header's macros it uses expand (braceDeltas). False
// when the depth cannot be told, or a linkage macro stands inside braces or parentheses in
// a line C++ also reads (`onlyC` false).
function readScope(scope, line, index, onlyC) {
  const { token, linkage, deltas } = scope;
  token.lastIndex = 0;
  for (let match; (match = token.exec(line));) {
    const text = match[0];
    if (text === "{") scope.depth++;
    else if (text === "(") scope.parens++;
    else if (text === "}") { if (--scope.depth < 0) return false; }
    else if (text === ")") { if (--scope.parens < 0) return false; }
    else if (BRACE_SPELLING.test(text)) return false;
    if (!onlyC && linkage.has(text) && (scope.depth !== 0 || scope.parens !== 0)) return false;
    const delta = deltas.get(text);
    if (delta === undefined || delta.index >= index) continue;
    CALL_OPEN.lastIndex = token.lastIndex;
    if (delta.unknown || (delta.functionLike && !CALL_OPEN.test(line))) return false;
    scope.depth += delta.braces;
    scope.parens += delta.parens;
    if (scope.depth < 0 || scope.parens < 0) return false;
  }
  return true;
}

/**
 * What linkagePlaced needs from the header's definitions, or null when a definition names
 * a linkage macro inside braces or parentheses: `groupMacros`, the macros its groups define
 * (`macros`); `linkage`, those and every macro a definition outside the groups builds from
 * one (`#define VEC_API VEC_EXTERN_C VEC_EXPORT`), directly or through others; `first`, the
 * line where the header first defines or removes each name; and `deltas` (braceDeltas).
 */
function scopeDefinitions({ lines, taken, dead, grouped }, macros) {
  const first = new Map(), definitions = [];
  for (let index = 0; index < lines.length; index++) {
    if (dead[index] || taken[index] === undefined) continue;
    const directive = directiveOf(lines[index]);
    if (directive?.name !== "define" && directive?.name !== "undef") continue;
    const defined = DEFINED_NAME.exec(directive.rest);
    if (!defined) continue;
    if (!first.has(defined[1])) first.set(defined[1], index);
    if (directive.name === "undef" || taken[index] === "c++") {
      if (directive.name === "undef" && taken[index] !== "c++") definitions.push({ name: defined[1], removed: true });
      continue;
    }
    definitions.push({ name: defined[1], index, shared: taken[index] === null, conditional: grouped[index],
      functionLike: /^[ \t]*[A-Za-z_]\w*\(/.test(directive.rest), ...macroBody(directive.rest.slice(defined[0].length)) });
  }
  const linkage = linkageMacros(definitions, macros);
  for (const { shared, names } of definitions) {
    if (shared && names?.some(({ name, nested }) => nested && linkage.has(name))) return null;
  }
  return { groupMacros: macros, linkage, first, deltas: braceDeltas(definitions) };
}

// The braces and parentheses a definition's body opens (positive) or closes (negative),
// whether it spells a brace otherwise, and the names it uses, each with whether a brace or
// parenthesis of the body is open before it (`nested`).
function macroBody(body) {
  let braces = 0, parens = 0, spelled = false;
  const names = [];
  for (const [text] of body.matchAll(SCOPE_TOKEN)) {
    if (text === "{") braces++;
    else if (text === "}") braces--;
    else if (text === "(") parens++;
    else if (text === ")") parens--;
    else if (BRACE_SPELLING.test(text)) spelled = true;
    else if (/^[A-Za-z_]/.test(text)) names.push({ name: text, nested: braces > 0 || parens > 0 });
  }
  return { braces, parens, spelled, names };
}

// The linkage macros: `macros`, and each macro a definition outside the groups builds from
// one of them, directly or through other such macros. One search over the definitions.
function linkageMacros(definitions, macros) {
  const users = new Map();
  for (const { name, shared, names } of definitions) {
    if (!shared) continue;
    for (const used of names) {
      if (!users.has(used.name)) users.set(used.name, new Set());
      users.get(used.name).add(name);
    }
  }
  const linkage = new Set(macros), queue = [...macros];
  while (queue.length) {
    for (const user of users.get(queue.pop()) ?? []) if (!linkage.has(user)) { linkage.add(user); queue.push(user); }
  }
  return linkage;
}

// The macros whose use moves the brace or parenthesis depth of the code C reads, by name:
// how far (`braces`, `parens`), whether the macro takes arguments, and the line of its
// first definition; or `unknown` when the depth a use moves cannot be told: the header
// defines it with different depths, inside a group (a branch the build may skip), or
// removes it, spells a brace otherwise, or its body uses such a macro (directly or
// through others).
function braceDeltas(definitions) {
  const own = new Map(), removed = new Set(), users = new Map();
  for (const definition of definitions) {
    if (definition.removed) { removed.add(definition.name); continue; }
    const { name, braces, parens, spelled, functionLike, conditional, index, names } = definition;
    const known = own.get(name), moves = braces !== 0 || parens !== 0;
    const unknown = spelled || (known !== undefined && (moves || known.braces !== 0 || known.parens !== 0)
      && (known.braces !== braces || known.parens !== parens || known.functionLike !== functionLike));
    own.set(name, { braces, parens, functionLike, index: known?.index ?? index, unknown: unknown || known?.unknown === true, conditional: conditional || known?.conditional === true });
    for (const used of names) {
      if (!users.has(used.name)) users.set(used.name, new Set());
      users.get(used.name).add(name);
    }
  }
  const deltas = new Map(), queue = [];
  for (const [name, delta] of own) {
    const moves = delta.braces !== 0 || delta.parens !== 0;
    if (delta.unknown || (moves && (delta.conditional || removed.has(name)))) deltas.set(name, { ...delta, unknown: true });
    else if (moves) deltas.set(name, delta);
    else continue;
    queue.push(name);
  }
  // A body that uses a macro which moves the depth moves it as that macro's use does,
  // which is not counted at its own use: such a macro is unknown, and so is every macro
  // whose body uses one, however indirectly.
  const reached = new Set(queue);
  while (queue.length) {
    for (const user of users.get(queue.pop()) ?? []) {
      if (reached.has(user)) { if (deltas.has(user)) deltas.get(user).unknown = true; continue; }
      reached.add(user);
      queue.push(user);
      deltas.set(user, { ...(own.get(user) ?? { braces: 0, parens: 0, functionLike: false, index: -1 }), unknown: true });
    }
  }
  return deltas;
}

// Whether a directive in a group only one language takes leaves the code after it the
// same for the other: a message, a pragma other than LANGUAGE_PRAGMA, a definition whose
// body is linkage or nothing; not one of LANGUAGE_DIRECTIVES or a line marker.
function sharedDirective({ name, rest }) {
  if (name === "define") return isLinkage(rest.slice(DEFINED_NAME.exec(rest)?.[0].length ?? 0));
  if (name === "pragma") return !LANGUAGE_PRAGMA.test(rest);
  return !LANGUAGE_DIRECTIVES.has(name) && !/^\d/.test(name);
}

/**
 * The configured units a header is compiled with, each visible to it through an include
 * directory or its own directory, by the language each unit is compiled in (a `.C` or
 * `.M` unit's declared standard decides): an Objective-C unit for Objective-C; a C++ unit for
 * C++ (a `.h` falls back to a C unit, which then rejects real C++); one unit of each
 * language for a header written for both; a C++ unit, else a C23 one, for C23-or-C++
 * spellings; otherwise a C unit, or a C++ unit first when only C++ files include it
 * (`includers.c` false), and for a C header with C++ linkage also a C++ unit when a C++
 * file includes it (`includers.cxx`). `includers` is undefined when nothing includes the
 * header by name. An empty list means no suitable unit.
 */
export function headerUnits(header, units, language = headerLanguage(header), includers = undefined) {
  return chooseUnits(firstVisible(visibilityIndex(units), header), header, language, includers);
}

/** The first unit `headerUnits` picks, or null. */
export function headerUnit(header, units, language = headerLanguage(header), includers = undefined) {
  return headerUnits(header, units, language, includers)[0] ?? null;
}

// headerUnits' choice among the first visible unit of each kind (firstVisible).
function chooseUnits(first, header, language, includers) {
  if (language === "objective-c") return first.platform ? [first.platform] : [];
  const { cxx, c, c23 } = first;
  const either = includers?.c === false ? [cxx ?? c] : [c ?? cxx];
  const choice = language === "c++" ? [cxx ?? (/\.h$/i.test(header) ? c : undefined)]
    : language === "c-and-c++" ? [c, cxx]
    : language === "c23-or-c++" ? [cxx ?? c23 ?? c]
    : language === "c-linkage" && includers?.cxx ? [...either, cxx]
    : either;
  return [...new Set(choice.filter(Boolean))];
}

// The kinds a configured unit counts as when a header or fragment it can see picks one:
// any platform unit, an Objective-C or Objective-C++ one, or a portable C, C++ or C23 one.
function unitKinds(unit) {
  const c = isCUnit(unit);
  if (isPlatformUnit(unit.file)) return ["platform", c ? "platformC" : "platformCxx"];
  return [c ? "c" : "cxx", ...(c && unit.standard === "c23" ? ["c23"] : [])];
}

// The configured units by the directories whose files they see (their own directory and
// their include directories, inside the repository): a trie of path components whose nodes
// hold, by configuration order, the units that see the files below them (`units`) and the
// first of each kind (`firsts`, unitKinds). Linear in the configuration.
function visibilityIndex(units) {
  const node = () => ({ children: new Map(), units: [], firsts: new Map() });
  const root = node();
  units.forEach((unit, order) => {
    for (const directory of new Set([posix.dirname(repositoryPath(unit.file)), ...(unit.includes ?? []).map(repositoryPath)])) {
      if (directory === ".." || directory.startsWith("../") || directory.startsWith("/")) continue;
      let at = root;
      for (const part of directory === "." ? [] : directory.split("/")) {
        if (!at.children.has(part)) at.children.set(part, node());
        at = at.children.get(part);
      }
      at.units.push(order);
      for (const kind of unitKinds(unit)) if (!at.firsts.has(kind)) at.firsts.set(kind, order);
    }
  });
  return { root, units };
}

// The trie nodes of the directories that hold `file` (visibilityIndex): one walk down its path.
function visibleNodes(visibility, file) {
  const nodes = [visibility.root], parts = repositoryPath(file).split("/");
  for (let at = 0, node = visibility.root; at < parts.length - 1 && (node = node.children.get(parts[at])); at++) nodes.push(node);
  return nodes;
}

// The first unit of each kind that can see `file`, by configuration order.
function firstVisible(visibility, file) {
  const orders = new Map();
  for (const node of visibleNodes(visibility, file)) {
    for (const [kind, order] of node.firsts) if (!(orders.get(kind) <= order)) orders.set(kind, order);
  }
  return Object.fromEntries([...orders].map(([kind, order]) => [kind, visibility.units[order]]));
}

// clang also reads the GNU `#import` in C and C++ (once per unit, like `#pragma once`). A
// quoted path ends at the next `"`, an angled one at the next `>`.
const INCLUDE = /^[ \t]*#[ \t]*(?:include(?:_next)?|import)[ \t]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)/gm;
// An include line's path as spelled, and whether it is quoted.
const includeOf = ([, quoted, angled]) => ({ quoted: quoted !== undefined, spelling: quoted ?? angled });
// The ways a path written in a source or in praesidium.json can name a directory or file: a
// backslash is part of a name for the compiler on POSIX and a separator on Windows, so a path
// that holds one is read both ways (a path Git lists, a changed file or a source's own,
// holds no separator but `/`).
const readings = path => path.includes("\\") ? [path, path.replaceAll("\\", "/")] : [path];
// An absolute include names no repository file; a normalized relative one may first climb.
const ABSOLUTE_SPELLING = /^(?:\/|[A-Za-z]:)/;

/**
 * The include lines of the native sources, read once per run (linear in them): `byName`,
 * the sources that include each name (the included path's last component, after the last
 * `/` or `\`); `names`, the
 * names each source includes; `headers`, the sources other than translation units by
 * their name; and `nameOf`, each source's name, null for a translation unit (which nothing
 * includes by name).
 */
function includeIndex(sources) {
  const byName = new Map(), names = new Map(), headers = new Map(), nameOf = new Map();
  const add = (map, key, file) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(file); };
  for (const { file, source } of sources) {
    if (typeof source !== "string" || !isNativeSource(file)) continue;
    nameOf.set(file, isTranslationUnit(file) ? null : posix.basename(file));
    if (nameOf.get(file) !== null) add(headers, nameOf.get(file), file);
    const included = new Set();
    for (const line of source.matchAll(INCLUDE)) {
      const name = posix.basename(includeOf(line).spelling.replaceAll("\\", "/"));
      add(byName, name, file);
      included.add(name);
    }
    if (included.size) names.set(file, [...included]);
  }
  return { byName, names, headers, nameOf };
}

// One include index per collected source list: headerJobs and fragmentJobs share it.
const includeIndexes = new WeakMap();
function sharedIncludeIndex(sources) {
  if (!includeIndexes.has(sources)) includeIndexes.set(sources, includeIndex(sources));
  return includeIndexes.get(sources);
}

// Which languages include each header, by name: `c` when a C (or Objective-C) file or a
// C-compatible `.h` does; `cxx` when C++ reads it: a C++ (or Objective-C++) file or a
// C++-only header includes it, directly or through headers and fragments of any language
// that do; undefined when nothing names it. A configured `.C` or `.M` counts in the
// language its standard declares (`declared`, from declaredLanguages); an unconfigured one,
// known only by its name, counts as both a C and a C++ file.
function includerIndex(sources, index, declared) {
  const sourceOf = new Map(sources.map(({ file, source }) => [file, source]));
  const languages = new Map();
  const languageOf = file => {
    if (!languages.has(file)) languages.set(file, headerLanguage(file, sourceOf.get(file)));
    return languages.get(file);
  };
  const readsAsC = file => declared.get(file) ?? (isCLanguageUnit(file) || isEitherLanguageUnit(file)
    || (/\.h$/i.test(file) && [null, "c-and-c++", "c-linkage"].includes(languageOf(file))));
  // Each name's includers are read once in all, however many changed headers share it: the
  // C readers found so far are kept, and two of them answer for any header.
  const cReaders = new Map();
  const cReaderBesides = (name, header) => {
    if (!cReaders.has(name)) cReaders.set(name, { rest: index.byName.get(name).values(), found: [] });
    const { rest, found } = cReaders.get(name);
    for (;;) {
      if (found.length > 1 || (found.length === 1 && found[0] !== header)) return true;
      const next = rest.next();
      if (next.done) return false;
      if (readsAsC(next.value)) found.push(next.value);
    }
  };
  let cxx;
  return header => {
    const name = posix.basename(header), includers = index.byName.get(name);
    if (!includers || includers.size === (includers.has(header) ? 1 : 0)) return undefined;
    cxx ??= cxxReadNames(sources, index, languageOf, declared);
    return { c: cReaderBesides(name, header), cxx: cxx.has(name) };
  };
}

// The names C++ reads: included by a C++ (or Objective-C++) translation unit (a configured
// `.C` or `.M` by its declared standard, an unconfigured one always) or a C++-only header,
// or by a header or fragment whose name C++ reads. Each source and each name is visited
// once, and only a header no C++ file reaches has its language read.
function cxxReadNames(sources, index, languageOf, declared) {
  const included = new Map();
  for (const { file } of sources) {
    if (isNativeSource(file) && !isTranslationUnit(file)) {
      const name = posix.basename(file);
      if (!included.has(name)) included.set(name, []);
      included.get(name).push(file);
    }
  }
  const reached = new Set(), visited = new Set();
  const visit = start => {
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      for (const name of index.names.get(queue.pop()) ?? []) {
        if (reached.has(name)) continue;
        reached.add(name);
        for (const file of included.get(name) ?? []) if (!visited.has(file)) { visited.add(file); queue.push(file); }
      }
    }
  };
  const readsAsCxx = file => isTranslationUnit(file) && !(declared.get(file) ?? isCLanguageUnit(file));
  for (const file of index.names.keys()) if (readsAsCxx(file)) visit(file);
  for (const file of index.names.keys()) {
    if (!visited.has(file) && isNativeHeader(file) && languageOf(file) === "c++") visit(file);
  }
  return reached;
}

// One walk up the include lines (walkUp): the include index, and the names it reached.
const walker = index => ({ index, marks: new Set() });

// Follows the include lines up from `names` toward the translation units that include
// them, directly or through headers that do, calling `found` with each such unit's file.
// A name the walk (from walker) reached already, in this call or an earlier one, is not
// followed again, so the walk reads each name's include lines once in all.
function walkUp(walks, names, found) {
  const { index, marks } = walks, queue = [];
  for (const name of names) if (!marks.has(name)) { marks.add(name); queue.push(name); }
  while (queue.length) {
    for (const includer of index.byName.get(queue.pop()) ?? []) {
      const parent = index.nameOf.get(includer);
      if (parent === null) found(includer);
      else if (!marks.has(parent)) { marks.add(parent); queue.push(parent); }
    }
  }
}

// The names the translation units `files` include, directly or through the headers of
// those names: each name and header is read once.
function namesReached(index, files) {
  const reached = new Set(), queue = [...files];
  while (queue.length) {
    for (const name of index.names.get(queue.pop()) ?? []) {
      if (reached.has(name)) continue;
      reached.add(name);
      for (const header of index.headers.get(name) ?? []) queue.push(header);
    }
  }
  return reached;
}

// The configured include directories (inside the repository, each in its readings), for
// pathSelections: the directories and their ancestors as a trie of path components, each
// node a number (0 is the repository root, `children` its children by component, `parent`
// its parent), with how many levels below each node the units list a directory, at least
// (`low`) and at most (`high`, -1 for none; 0 when a unit lists the node itself); `listed`,
// the nodes each unit lists; `byFile`, each unit by its file; and `order`, its place in the
// configuration. Linear in the configured directories' length.
function includeDirectories(units) {
  const children = [new Map()], parent = [0], low = [Infinity], high = [-1], listed = new Map();
  const byFile = new Map(units.map(unit => [unit.file, unit])), order = new Map(units.map((unit, index) => [unit, index]));
  for (const unit of units) {
    const nodes = new Set();
    for (const include of (unit.includes ?? []).flatMap(readings)) {
      const { up, parts } = pathParts(include);
      if (up) continue;
      let node = 0;
      for (const part of parts) {
        if (!children[node].has(part)) {
          children[node].set(part, children.length);
          children.push(new Map()); parent.push(node); low.push(Infinity); high.push(-1);
        }
        node = children[node].get(part);
      }
      low[node] = 0;
      high[node] = Math.max(high[node], 0);
      nodes.add(node);
    }
    listed.set(unit, [...nodes]);
  }
  // A node is numbered after its parent, so counting down reads every child before its
  // parent; each node lies on the path of a listed directory.
  for (let node = children.length - 1; node > 0; node--) {
    low[parent[node]] = Math.min(low[parent[node]], low[node] + 1);
    high[parent[node]] = Math.max(high[parent[node]], high[node] + 1);
  }
  return { children, parent, low, high, listed, byFile, order };
}

// Selects, by the first changed file that does (`select(unit, position)`), each configured
// unit whose compiler can read one of `files` (outside the extension table, scripts, or
// fragments past the unit limit) through an include line in a source it reaches (its own
// file, or a header it includes by name, directly or through headers), as changedLines and
// pathMatches find the lines: a unit that reaches a quoted line naming the file from the
// line's own directory; and a unit that reaches a line naming it under a directory some
// unit lists, when the unit itself lists a directory under which such a line names a
// changed file (admittedAt). A name alone never matches: a changed `tools/version` is not
// the `<version>` a unit includes unless that unit lists `tools`. Each set of matching
// lines is read once in all: its translation units directly, its headers in one walk up
// the include lines for all the files, in their order (follower). A unit is selected under
// the first file whose lines it reaches, or under the first file that admits it when that
// comes later.
function pathSelections(files, sources, directories, select) {
  const lines = changedLines(sources, files.map(({ file }) => file));
  if (!lines.matched) return;
  const index = sharedIncludeIndex(sources), quoted = follower(index, directories), searched = follower(index, directories);
  const reached = new Map(), marks = new Map();
  for (const { file, position } of files) {
    const path = lines.changed.get(file);
    if (!path) continue;
    quoted.follow(path.node.quoted ? [path.node.quoted] : [], unit => select(unit, position));
    const matches = pathMatches(path.parts, lines, directories);
    for (const { ancestor, low, high } of matches) {
      const mark = marks.get(ancestor);
      if (!mark) marks.set(ancestor, { low, high, position });
      else { mark.low = Math.min(mark.low, low); mark.high = Math.max(mark.high, high); }
    }
    searched.follow(matches.map(({ includers }) => includers), unit => { if (!reached.has(unit)) reached.set(unit, position); });
  }
  for (const [unit, position] of reached) {
    const admitted = admittedAt(unit, directories, marks);
    if (admitted < Infinity) select(unit, Math.max(position, admitted));
  }
}

// Follows sets of include lines (each a set of sources) to the configured units that
// reach them, calling `found` with each: a set's translation units directly, its headers
// in one walk up the include lines (walkUp). Each set and each name is read once in all.
function follower(index, directories) {
  const read = new Set(), walks = walker(index);
  const unitFound = (file, found) => { const unit = directories.byFile.get(file); if (unit) found(unit); };
  return {
    follow(sets, found) {
      const names = [];
      for (const includers of sets) {
        if (read.has(includers)) continue;
        read.add(includers);
        for (const source of includers) {
          const name = index.nameOf.get(source);
          if (name !== null) names.push(name);
          else unitFound(source, found);
        }
      }
      walkUp(walks, names, file => unitFound(file, found));
    },
  };
}

// The first position at which a unit is admitted: it lists a directory below a directory
// a changed file's lines were found under (`marks`, by includeDirectories node: the least
// and the most climbs of those lines, and the first file), at a level within those climbs.
// One walk up from each directory the unit lists, so linear in the unit's configuration.
function admittedAt(unit, directories, marks) {
  let first = Infinity;
  for (const listed of directories.listed.get(unit)) {
    for (let node = listed, level = 0; ; node = directories.parent[node], level++) {
      const mark = marks.get(node);
      if (mark && mark.low <= level && level <= mark.high) first = Math.min(first, mark.position);
      if (node === 0) break;
    }
  }
  return first;
}

// Selects, by the first changed fragment that does, the configured units that see each of
// `fragments` by directory (`seen`; each trie node's units read once) and those that
// include its name, directly or through headers (`named`; one walk up from all the names,
// each read once). Returns the fragments that some native source includes but no
// configured unit reaches, with whether only Objective-C units include them (`platform`),
// from the names all, portable and configured translation units reach (namesReached, read
// once and only when needed).
function fragmentSelections(fragments, sources, directories, visibility, seen, named) {
  if (!fragments.length) return [];
  const index = sharedIncludeIndex(sources), walks = walker(index), unreached = [];
  let reached;
  for (const { file, position } of fragments) {
    const nodes = visibleNodes(visibility, file), name = posix.basename(file);
    for (const node of nodes) {
      if (node.read) continue;
      node.read = true;
      for (const order of node.units) seen(visibility.units[order], position);
    }
    walkUp(walks, [name], file => { if (directories.byFile.has(file)) named(directories.byFile.get(file), position); });
    if (nodes.some(node => node.units.length) || !index.byName.has(name)) continue;
    if (!reached) {
      const translationUnits = [...index.names.keys()].filter(isTranslationUnit);
      reached = { units: namesReached(index, translationUnits.filter(unit => directories.byFile.has(unit))),
        any: namesReached(index, translationUnits), portable: namesReached(index, translationUnits.filter(unit => !isPlatformUnit(unit))) };
    }
    if (!reached.units.has(name)) unreached.push({ position, platform: reached.any.has(name) && !reached.portable.has(name) });
  }
  return unreached;
}

/**
 * The include lines that can name one of the changed `files`, read once per lookup, each
 * spelling in its readings (readings): `changed`, each file's path components (`parts`;
 * none for a path that climbs out of the root) and its node in a trie of the changed paths
 * (`node`), which holds the sources whose quoted include names it relative to their own
 * directory, where the compiler looks first (`quoted`); and `spellings`, the files'
 * components from the last one as a trie, whose node for the rest of a file's path below
 * one of its directories holds the sources whose include lines spell that rest after a
 * climb (`includers`), which the compiler looks up in the include directories, and the
 * least and the most levels those spellings first climb (`low`, `high`; 0 for none,
 * `../../x.h` climbs 2); `matched`, whether any line can name a changed file. Only what
 * the changed paths hold is kept: a spelling is followed from its last component only
 * while the trie holds it, and a quoted one from its source's directory, found in the
 * trie of the changed paths once per source. A line thus costs its own length, not its
 * source's path, and the lookup is linear in the include lines and the changed paths.
 */
function changedLines(sources, files) {
  const changed = new Map(), paths = trieNode(), spellings = trieNode();
  let matched = false;
  for (const file of files) {
    const { up, parts } = pathParts(file);
    if (up || !parts.length) continue;
    changed.set(file, { parts, node: parts.reduce(trieAdd, paths) });
    parts.reduceRight(trieAdd, spellings);
  }
  for (const { file, source } of sources) {
    if (typeof source !== "string" || !isNativeSource(file)) continue;
    let directory;
    for (const line of source.matchAll(INCLUDE)) {
      const { quoted: local, spelling: written } = includeOf(line);
      for (const spelling of readings(written)) {
        // An absolute spelling, or one that ends in a directory, names no repository file.
        if (ABSOLUTE_SPELLING.test(spelling) || spelling.endsWith("/")) continue;
        const { up, parts: rest } = pathParts(spelling);
        if (!rest.length) continue;
        if (local) {
          directory ??= directoryNodes(paths, file);
          let at = directory.nodes[directory.depth - up];
          for (let index = 0; at && index < rest.length; index++) at = trieChild(at, rest[index]);
          // A line that names a changed file here also spells the rest of its path (below).
          if (at) (at.quoted ??= new Set()).add(file);
        }
        let at = spellings;
        for (let index = rest.length - 1; at && index >= 0; index--) at = trieChild(at, rest[index]);
        if (!at) continue;
        (at.includers ??= new Set()).add(file);
        matched = true;
        at.low = Math.min(at.low ?? up, up);
        at.high = Math.max(at.high ?? up, up);
      }
    }
  }
  return { changed, spellings, matched };
}

// A node of a trie of path components (changedLines): its one child inline (`part`,
// `next`), its children in a Map only once it has two, so an unbranched run of components
// (a deep changed path) costs no Map per component.
const trieNode = () => ({ part: undefined, next: undefined, children: undefined });

// The child of `node` for `part`, or undefined.
function trieChild(node, part) {
  return node.children ? node.children.get(part) : node.part === part ? node.next : undefined;
}

// The child of `node` for `part`, added when missing.
function trieAdd(node, part) {
  const found = trieChild(node, part);
  if (found) return found;
  const child = trieNode();
  if (node.children) node.children.set(part, child);
  else if (node.next === undefined) { node.part = part; node.next = child; }
  else node.children = new Map([[node.part, node.next], [part, child]]);
  return child;
}

// The nodes of a trie of paths along a source's directory, as far as the trie holds it, and
// the directory's depth.
function directoryNodes(trie, file) {
  const components = pathParts(file).parts.slice(0, -1), nodes = [trie];
  for (const part of components) {
    const next = trieChild(nodes.at(-1), part);
    if (!next) break;
    nodes.push(next);
  }
  return { nodes, depth: components.length };
}

// The include lines that can name a changed file (its components `parts`, from
// changedLines) through an include directory, with the directory above the file they are
// found under (`ancestor`, an includeDirectories node) and their climbs (`low`, `high`):
// for each directory above the file, the lines spelling the rest of its path below it,
// when the levels those lines first climb and the levels below the directory at which
// units list directories overlap as ranges. So lines that do not climb, where no line
// spelled alike climbs, name the file exactly when some unit lists that directory; with
// climbs, more lines may match, never fewer. The file's components are walked once forward
// through the directories and once backward through the spellings, a constant check at
// each, so it is linear in the path.
function pathMatches(parts, lines, directories) {
  const matches = [], prefixes = [0];
  for (let depth = 1; depth < parts.length && prefixes[depth - 1] !== undefined; depth++) {
    prefixes.push(directories.children[prefixes[depth - 1]].get(parts[depth - 1]));
  }
  let node = lines.spellings;
  for (let depth = parts.length - 1; depth >= 0 && (node = trieChild(node, parts[depth])); depth--) {
    const ancestor = prefixes[depth];
    if (ancestor === undefined || !node.includers) continue;
    if (node.low <= directories.high[ancestor] && directories.low[ancestor] <= node.high) {
      matches.push({ includers: node.includers, ancestor, low: node.low, high: node.high });
    }
  }
  return matches;
}

// The changed headers and the units each is compiled with. An Objective-C-looking header
// is compiled with a visible Objective-C unit (objectiveCUnit); without one, a visible
// portable unit first probes whether it reads as C or C++ at all (`probe`), and only a
// header that does not is reported as not analyzed, like an unconfigured .mm unit (the
// host may lack the SDK). A header whose Objective-C markers are all conditional
// (`#ifdef __OBJC__`) is portable, but when no portable unit can see it, it is handled as
// Objective-C: compiled with a visible Objective-C unit, else not analyzed. Any other
// header without a unit (unit null) is a configuration error.
function headerJobs(sources, units, changed) {
  const headers = changed ? sources.filter(({ file }) => isNativeHeader(file) && changed.has(file)) : [];
  if (!headers.length) return [];
  const includers = includerIndex(sources, sharedIncludeIndex(sources), declaredLanguages(units));
  const visibility = visibilityIndex(units);
  return headers.flatMap(({ file, source }) => {
    const code = maskedHeader(source);
    const language = codeLanguage(file, code), first = firstVisible(visibility, file);
    if (language === "objective-c") {
      const portable = portableLanguage(file, code);
      const unit = objectiveCUnit(first, portable);
      if (unit) return [{ header: file, language, unit, probe: false }];
      const fallback = chooseUnits(first, file, portable, includers(file))[0] ?? null;
      return [{ header: file, language, unit: fallback, probe: fallback !== null }];
    }
    const chosen = chooseUnits(first, file, language, includers(file));
    if (chosen.length) return chosen.map(unit => ({ header: file, language, unit, probe: false }));
    if (OBJECTIVE_C_HEADER.test(code) && !first.c && !first.cxx) {
      return [{ header: file, language: "objective-c", unit: objectiveCUnit(first, language), probe: false }];
    }
    return [{ header: file, language, unit: null, probe: false }];
  });
}

// The configured Objective-C unit that compiles a header, among the first visible ones
// (firstVisible): an Objective-C++ unit for a header that is C++ by its extension or
// spellings (portable language c++), else an Objective-C unit first; null when none fits.
function objectiveCUnit(first, portable) {
  if (portable === "c++") return first.platformCxx ?? null;
  return first.platformC ?? first.platformCxx ?? null;
}

// A changed fragment (.inc, .def) cannot be compiled alone; the configured units that can
// see it by directory, or that include it by name (directly or through a header), are
// compiled instead, each once, reported under the first changed file that selects it. When
// those units and the units the other changed files select would not fit in `room` (what
// the unit limit leaves), the units that only include a fragment's name give way to those
// whose compiler can read that very fragment through an include line they reach, as for the
// files below (pathSelections). A fragment some native
// source includes but no configured unit reaches has no unit (unit null): a configuration
// error, or not analyzed when only Objective-C units include it. A fragment nothing
// includes by name and no unit sees is not known to be C or C++ (`.inc` is also PHP,
// assembler, Pascal), so it is not analyzed and, never read by a compiler, not scanned. A
// changed file outside the extension table (`.txt`, extensionless) or a script source is
// compiled the same way through the configured units whose compiler can read that very
// file through an include line they reach (pathSelections); without one it is left alone,
// since a name alone does not make a file C or C++. Linear in the include lines, the
// configuration and the changed files.
function fragmentJobs(sources, units, changed, selected, room = Infinity) {
  const spliced = changed ? [...changed].filter(file => !isNativeSource(file) || isNativeFragment(file)) : [];
  if (!spliced.length) return [];
  const directories = includeDirectories(units), visibility = visibilityIndex(units), scheduled = new Set(selected);
  // Each unit not already in scope, by the first changed file that selects it: by path and
  // by directory, and also by a fragment's name (`broad`).
  const byPath = new Map(), broad = new Map();
  const into = firstFile => (unit, position) => {
    if (!scheduled.has(unit) && !(firstFile.get(unit) <= position)) firstFile.set(unit, position);
  };
  const files = spliced.map((file, position) => ({ file, position }));
  const fragments = files.filter(({ file }) => isNativeFragment(file));
  pathSelections(files.filter(({ file }) => !isNativeFragment(file)), sources, directories, into(byPath));
  const unreached = new Map(fragmentSelections(fragments, sources, directories, visibility, into(byPath), into(broad))
    .map(({ position, platform }) => [position, platform]));
  for (const [unit, position] of byPath) into(broad)(unit, position);
  const fits = broad.size <= room;
  if (!fits) pathSelections(fragments, sources, directories, into(byPath));
  const firstFile = fits ? broad : byPath, byFile = spliced.map(() => []);
  for (const [unit, position] of firstFile) byFile[position].push(unit);
  return spliced.flatMap((fragment, position) => unreached.has(position)
    ? [{ fragment, unit: null, platform: unreached.get(position) }]
    : byFile[position].sort((a, b) => directories.order.get(a) - directories.order.get(b)).map(unit => ({ fragment, unit })));
}

/**
 * `options.changed` (a Set of paths changed by the reviewed PR) scopes configuration and
 * compilation to changed translation units. Without it every tracked unit is in scope,
 * which is also the fail-closed fallback when the changed set cannot be computed.
 * `options.findings`, an array, receives the policy findings in repository files the
 * compiler read that are outside the policy scan (dependencyFindings, which reads the Git
 * listing the collection of `sources` read: repositoryFiles), and the analyzer's suppress
 * attribute wherever the expansion pass found it.
 */
export async function analyzeNative(root, sources, units = [], execute = analyzeProcess, options = {}) {
  const changed = options.changed instanceof Set ? options.changed : null;
  const inScope = file => !changed || changed.has(file);
  const nativeFiles = sources.filter(({ file }) => isTranslationUnit(file)).map(({ file }) => file), tracked = new Set(nativeFiles);
  const headers = sources.filter(({ file }) => isNativeHeader(file) && inScope(file)).map(({ file }) => file);
  if (!Array.isArray(units)) throw new Error("invalid native configuration");
  if (new Set(units.map(unit => unit?.file)).size !== units.length) throw new Error("duplicate native unit");
  for (const unit of units) {
    validateNativeUnit(unit);
    if (!tracked.has(unit.file)) throw new Error("untracked translation unit");
  }
  // clang lists a name that holds a backslash with a slash there, so a changed file whose
  // path holds one (a fragment, an included file) cannot be matched reliably (fail closed).
  if (changed && units.length && [...changed].some(file => file.includes("\\"))) throw new Error("backslash in a changed path");
  // Objective-C/C++ needs the platform SDK, which an inspection host may lack, so only
  // those units (and headers no configured unit can compile) may stay unconfigured;
  // scan.mjs reports them as not analyzed. A changed header is analyzed with a configured
  // unit of its language that can see it (RV-PRAESIDIUM-03), so it needs one; across the
  // whole repository, headers are covered through the units.
  const jobs = headerJobs(sources, units, changed).filter(job => job.unit || job.language !== "objective-c");
  const selected = units.filter(unit => inScope(unit.file));
  const fragments = fragmentJobs(sources, units, changed, selected, UNIT_LIMIT - selected.length - jobs.length)
    .filter(job => job.unit || !job.platform);
  const configured = new Set(units.map(unit => unit.file));
  if (nativeFiles.some(file => inScope(file) && !isPlatformUnit(file) && !configured.has(file))
      || jobs.some(job => !job.unit) || fragments.some(job => !job.unit)
      || (!changed && headers.length > 0 && units.length === 0)) {
    return [{ rule: "native.configuration-required", status: "error" }];
  }
  if (selected.length + jobs.length + fragments.length > UNIT_LIMIT) throw new Error("native analysis unit limit");
  if (!selected.length && !jobs.length && !fragments.length) return [];
  const host = options.host ?? readNativeHost(root, options.env);
  const workspace = mkdtempSync(join(tmpdir(), "praesidium-native-"));
  try {
    // Validate every invocation before any compiler starts, so a later invalid unit cannot orphan workers.
    const listed = index => ({ dependencies: join(workspace, `${index}.d`) });
    const invocations = [
      ...selected.map(unit => ({ unit, file: unit.file })),
      ...jobs.map(({ header, unit, probe }) => ({ unit, header, probe, file: header })),
      ...fragments.map(({ fragment, unit }) => ({ unit, file: fragment })),
    ].map(({ unit, header = null, probe = false, file }, index) => ({
      ...nativeInvocation(root, unit, host, header, { ...listed(index), probe }), file, probe }));
    const read = new Map(), expanded = new Map();
    const outcomes = await analyzeNativeBatch(invocations, async (command, args, cwd) => {
      const result = await execute(command, args, cwd);
      if (Array.isArray(result?.dependencies)) read.set(args, result.dependencies);
      if (Array.isArray(result?.suppressions)) expanded.set(args, result.suppressions);
      return result;
    }, options.now);
    const lists = invocations.map(invocation => invocation.passes.map(args => read.get(args)).find(Boolean) ?? []);
    const findings = dependencyFindings(root, lists, repositoryFiles(root, sources));
    lists.forEach((list, index) => {
      if (outcomes[index].status === "passed" && list.some(path => findings.flagged.has(path))) outcomes[index].status = "failed";
    });
    if (Array.isArray(options.findings)) options.findings.push(...findings.items, ...suppressionFindings(root, invocations, expanded));
    return outcomes;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// The expansion pass's hits as policy findings, each in the repository file whose line
// applies the attribute (the analyzed file when the line lies outside the repository).
// The unit already failed through its pass.
function suppressionFindings(root, invocations, expanded) {
  const realRoot = realpathSync(root), seen = new Set(), items = [];
  invocations.forEach(invocation => {
    for (const { path, line } of invocation.passes.flatMap(args => expanded.get(args) ?? [])) {
      let file = null;
      try { file = path === null ? null : repositoryFile(realRoot, root, path); } catch { /* named a file that is gone */ }
      const item = { rule: "native.analysis-suppression", file: file ?? invocation.file, line, severity: "high" };
      const key = `${item.file}\0${line}`;
      if (!seen.has(key)) { seen.add(key); items.push(item); }
    }
  });
  return items;
}

/**
 * Changed (or, without a change set, all) platform units that have no native entry,
 * changed Objective-C headers that no configured unit can compile, and changed fragments
 * that only such units include. A header compiled through a probe that fails is reported
 * by analyzeNative (`native.not-analyzed`).
 */
export function unanalyzedPlatformUnits(sources, units, changed) {
  const list = Array.isArray(units) ? units.filter(unit => typeof unit?.file === "string") : [];
  const configured = new Set(list.map(unit => unit.file));
  const selected = list.filter(unit => !changed || changed.has(unit.file));
  return [
    ...sources.map(({ file }) => file)
      .filter(file => isPlatformUnit(file) && (!changed || changed.has(file)) && !configured.has(file)),
    ...headerJobs(sources, list, changed).filter(job => job.language === "objective-c" && !job.unit).map(job => job.header),
    ...fragmentJobs(sources, list, changed, selected).filter(job => !job.unit && job.platform).map(job => job.fragment),
  ];
}
// @ts-expect-error augur-inject
analyzeNative = contract(analyzeNative, { ...augurContract_5d2a8f17, contractId: 'C-19', mode: 'observe', sample: 1, where: 'src/praesidium/native.mjs:59', rule: 'contract-wrap', id: '5d2a8f17' }); /* augur-inject:contract-wrap:5d2a8f17 */
