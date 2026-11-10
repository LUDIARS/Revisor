import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFindings } from "../src/praesidium/rules.mjs";
import { maskNativeCode } from "../src/praesidium/native-lexer.mjs";
import { scanRepository } from "../src/praesidium/scan.mjs";
import { analyzeNative, analyzeProcess, declaredLanguages, dependencyList, headerLanguage, headerUnit, headerUnits,
  nativeInvocation, unanalyzedPlatformUnits } from "../src/praesidium/native.mjs";
import { isCLanguageUnit, isEitherLanguageUnit, isNativeFragment, isNativeHeader, isPolicySource, isTranslationUnit,
  unitLanguage } from "../src/praesidium/languages.mjs";
import { NATIVE_BASELINE_HEADER, NATIVE_WARNINGS } from "../src/praesidium/native-baseline.mjs";
import { readNativeHost } from "../src/praesidium/native-host.mjs";
import { analyzeNativeBatch } from "../src/praesidium/native-batch.mjs";
import { expandedSuppressions, expansionLexing, holdsObjectiveC, suppressAttributeOffsets } from "../src/praesidium/native-expansion.mjs";

// A repository: the dependency scan reads the files Git tracks or would add.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "praesidium-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

test("syntactic rules identify concrete dangerous calls without reporting literals/comments", () => {
  assert.equal(sourceFindings("a.cpp", "void f() { strcpy(dst, src); }")[0].rule, "native.unbounded-copy");
  assert.equal(sourceFindings("a.js", "eval(userInput)")[0].rule, "web.dynamic-code");
  assert.equal(sourceFindings("a.js", "node.innerHTML = req.query.content")[0].rule, "web.request-to-html");
  assert.equal(sourceFindings("a.js", "exec(req.body.cmd)")[0].rule, "web.request-to-shell");
  assert.deepEqual(sourceFindings("a.js", '// eval(foo)\nconst x = "eval(foo)";'), []);
  assert.deepEqual(sourceFindings("a.cpp", '/* strcpy(a,b) */\nconst char* text = "strcpy(a,b)";'), []);
});

test("C/C++ masking follows the language's lexer, so valid literals cannot hide a dangerous call", () => {
  const hidden = [
    "constexpr int k = 1'000; strcpy(dst, src); char c = 'x';",
    'auto s = R"( " )"; strcpy(d, s); auto t = "";',
    "#error don't\nvoid f() { strcpy(a, b); }\nchar q = 'x';",
    "#include <x/*y>\nvoid f() { strcpy(a, b); }\n/* */",
    "#if __has_include(<a/*b>)\n#endif\nvoid f() { strcpy(a, b); }\n/* */",
    "#if __has_include_next(<a/*b>)\n#endif\nvoid f() { strcpy(a, b); }\n/* */",
    'auto s = R"(unterminated\nstrcpy(a, b);',
    "unsigned long long z = 0b1010'1010ull; double e = 1.5e-3; strcpy(a, b);",
  ];
  for (const code of hidden) assert.equal(sourceFindings("a.cpp", code)[0]?.rule, "native.unbounded-copy", code);
  assert.equal(sourceFindings("a.cpp", "#error don't\nvoid f() { strcpy(a, b); }")[0].line, 2);
  const literal = [
    'auto s = R"xy( )" strcpy( )xy"; int z;',
    'auto s = u8R"(\nstrcpy(a, b)\n)";',
    "// note \\\nstrcpy(a, b);",
    'const char* s = "a\\"strcpy(b)";',
    'auto w = L"strcpy(";',
    'NSString* s = @"strcpy(a, b)";',
  ];
  for (const code of literal) assert.deepEqual(sourceFindings("a.mm", code), [], code);
});

test("C/C++ masking stays linear on adversarial raw strings, header names, splices, numbers and UCNs", () => {
  const started = performance.now();
  sourceFindings("a.cpp", 'R"('.repeat(200_000));
  sourceFindings("a.cpp", ('R"' + "a".repeat(15) + "(\n").repeat(60_000));
  sourceFindings("a.cpp", ')xx"'.repeat(400_000));
  sourceFindings("a.cpp", "#include <" + "x".repeat(1_000_000));
  // Many openers and `)` but no `)a"`: a per-literal terminator search rescans the rest.
  sourceFindings("a.cpp", 'R"a()\n'.repeat(100_000));
  // Long blank runs after backslashes, in code and in literals (2 MiB each).
  sourceFindings("a.cpp", ("\\" + " ".repeat(1000) + "x").repeat(2000));
  sourceFindings("a.cpp", ('"\\' + " ".repeat(1000) + "x\n").repeat(2000));
  // Digit separators, unfinished UCNs, and a line of `\N{` with no `}` (read once).
  sourceFindings("a.cpp", "1" + "'1".repeat(1_000_000));
  sourceFindings("a.cpp", "1\\u{".repeat(500_000));
  sourceFindings("a.cpp", "x" + "\\u{e9}".repeat(300_000));
  sourceFindings("a.cpp", "\\N{".repeat(40_000));
  // Directive heads read twice (`#pragma` before a word other than `mark`), raw directive
  // text across splices, whitespace names, layout UCNs and header-name escapes (2 MiB each).
  sourceFindings("a.cpp", "#pragma" + " /**/".repeat(400_000));
  sourceFindings("a.cpp", "#error " + "\\\n".repeat(1_000_000));
  sourceFindings("a.cpp", "\\N{NO-BREAK SPACE".repeat(120_000) + "}");
  sourceFindings("a.cpp", "#\\u00a0".repeat(300_000));
  sourceFindings("a.cpp", "#include <" + "\\>".repeat(1_000_000));
  assert.ok(performance.now() - started < 20_000);
  // Without a `'`, the C17 and C23 readings mask a source alike, so a header or an
  // unconfigured `.C` is masked twice, not three times: 2 MiB of `\N{` costs about twice
  // its one C++ reading (it was more than three times, over 1.5 s).
  const named = "\\N{".repeat(699_050), fastest = (file) => Math.min(...[0, 1, 2].map(() => {
    const begun = performance.now();
    sourceFindings(file, named);
    return performance.now() - begun;
  }));
  const cxx = fastest("a.cpp");
  for (const file of ["a.h", "a.C"]) assert.ok(fastest(file) < 2.7 * cxx, file);
  assert.deepEqual(sourceFindings("a.h", "\\N{LATIN SMALL LETTER A}\n??/\nx").map(item => item.rule).sort(), ["native.named-ucn", "native.trigraph"]);
});

test("native tripwires cover Win32 spellings, unbounded scans, stack allocation, shell and temp names", () => {
  const rejected = {
    // Parenthesized names are calls in every rule, and the builtins are the same calls.
    "native.unbounded-copy": ["(strcpy)(d, s);", "((strcpy))(d, s);", "lstrcpyA(d, s);", "wsprintfW(d, L\"%s\", s);", "_tcscpy(d, s);",
      "StrCpyW(d, s);", "getwd(d);", '__builtin_sprintf(d, "%s", s);', '__builtin_vsprintf(d, "%s", ap);',
      '__builtin___sprintf_chk(d, 0, n, "%s", s);', '(__builtin_sprintf)(d, "%s", s);',
      // The glibc entry points the builtins lower to take any size, too.
      '__sprintf_chk(d, 0, (size_t)-1, "%s", s);', "__vsprintf_chk(d, 0, (size_t)-1, f, ap);", "__gets_chk(b, (size_t)-1);"],
    "native.unbounded-scan": ['std::scanf("%s", d);', 'sscanf(s, "%d %ls", &n, w);', 'scanf("%" "s", d);',
      'fscanf(f, "%[^\\n]", d);', 'sscanf(get(")"), "%s", d);', '(std::sscanf)(in, "%s", b);', '(_tscanf)(_T("%s"), b);',
      '__builtin_sscanf(in, "%s", b);', 'swscanf(in, L"%S", b);', '__isoc99_sscanf(in, "%s", b);', '__isoc23_scanf("%s", b);',
      // A format argument the bounded walk cannot reach fails closed.
      'sscanf(in /* ' + "x".repeat(300) + ' */, "%s", b);',
      // glibc takes a zero width as none and reads the ' and I flags and the q modifier.
      'sscanf(in, "%0s", b);', "sscanf(in, \"%'s\", b);", 'sscanf(in, "%Is", b);', 'sscanf(in, "%1$0s", b);',
      'sscanf(in, "%00[A]", b);', 'sscanf(in, "%qs", b);', 'swscanf(in, L"%0ls", w);',
      // A raw string's delimiter is not part of the format.
      'std::sscanf(in, R"(%)" "s", b);', 'std::sscanf(in, "%" R"(s)", b);'],
    "native.stack-allocation": ["void* p = alloca(n);", "_alloca(n);", "__builtin_alloca(n);", "(alloca)(n);",
      "__builtin_alloca_uninitialized(n);", "__builtin_alloca_with_align_uninitialized(n, 64);"],
    // A keyword before `::` is not a namespace.
    "native.command-execution": ["std::system(cmd);", "::system(cmd);", 'FILE* p = popen(c, "r");', "(std::system)(cmd);",
      '(popen)(c, "r");', "((((((((((system))))))))))(c);", "return ::system(cmd);", "else ::system(cmd);",
      'return ::popen(c, "r");', "bool r = ok xor ::system(c);", "return __extension__ ::system(cmd);", "int r = __real__ ::system(c);"],
    "native.insecure-temp-name": ["std::tmpnam(nullptr);", "mktemp(t);", "(std::tmpnam)(b);", "(mktemp)(t);"],
    "native.identifier-splice": ["str\\\ncpy(d, s);"],
    // An asm label, weakref or alias attribute, linker alias or redefine_extname pragma binds a
    // declaration to a rejected function's symbol; an asm statement can call one by name.
    "native.symbol-alias": ['char* cp(char*, const char*) __asm__("strcpy");', 'int run(const char*) asm("system");',
      'char* cp(char*, const char*) __asm("_strcpy");', 'static char* cp(char*, const char*) __attribute__((weakref("strcpy")));',
      'char* cp(char*, const char*) __attribute__((__alias__("strcpy")));', 'char* cp(char*, const char*) __asm__("" "str" "cpy");',
      'char* cp(char*, const char*) __asm__("str\\x63py");', 'char* cp(char*, const char*) __asm__(R"(strcpy)");',
      '__asm__ __volatile__("call strcpy@PLT");', 'asm volatile goto("jmp _popen" :::: done);', '__asm__(".symver cp, strcpy@GLIBC_2.2.5");',
      '#pragma comment(linker, "/alternatename:cp=strcpy")', "#pragma redefine_extname cp strcpy", "#pragma redefine_extname cp strcpy,",
      'int r(const char*, ...) __asm__("__isoc99_sscanf");', 'char* t(char*) __asm__("tmpnam");'],
  };
  for (const [rule, cases] of Object.entries(rejected)) {
    for (const code of cases) assert.equal(sourceFindings("a.cpp", code)[0]?.rule, rule, code);
  }
  // The symbol is read like a format: splices joined (with blanks before the line break) before escapes.
  for (const code of ['char* cp(char*, const char*) __asm__("str\\\ncpy");', 'char* cp(char*, const char*) __asm__("str\\ \n\rcpy");']) {
    assert.deepEqual(sourceFindings("a.c", code).map(item => item.rule), ["native.symbol-alias"], code);
  }
  // A banned.h-style defense, bounded scans and same-named members are not uses.
  for (const code of ["#define strcpy(x, y) BANNED(strcpy)", "#  undef strcpy", 'scanf("%15s", d);',
    'scanf("%*s %d", &n);', 'scanf("%%s", d);', 'scanf_s("%s", d, 10);', "obj.system(cmd);", "ptr->system(cmd);",
    "game::system(dt);", "std::system_error e;", "absl::StrCat(a, b);", "int alloca_count = 0;",
    "#define LONG_MACRO \\\n  value", "using ::strcpy;", '(scanf)("%7s", b);', '(std::sscanf)(in, "%31s", b);',
    "(game::system)(dt);", "return game::system(dt);", "(obj.system)(x);", '__builtin_scanf("%9s", b);',
    '__builtin_snprintf(d, n, "%s", s);', "strcpy_chk(d, n, s);", 'std::sscanf(in, R"(%15s)", b);',
    'std::sscanf(in, R"%(abc)%" "s", b);', 'sscanf(in, "%05s", b);', "sscanf(in, \"%'*s\", b);", 'sscanf(in, "%0ms", b);',
    'sscanf(in, "%%0s", b);', '__isoc99_scanf("%9s", b);', '__snprintf_chk(d, n, 0, n, "%s", s);',
    // Symbols of other functions, asm text that names none, and a symbol a macro supplies.
    'double f(double) __asm__("snprintf_l");', '__asm("_ZSt8to_charsPcS_e");', 'asm("" : "+m"(x));', 'asm volatile("nop");',
    'void f(void) __attribute__((alias("my_strcpy")));', '__asm__("mov %0, system_reg" : "=r"(x));', "__asm__(SYMBOL(strcpy));",
    "#pragma redefine_extname old_name new_name", 'auto s = "asm(\\"strcpy\\")";',
    // A member named alias is no attribute.
    'app.add_subcommand("info")->alias("system");', 'cmd . alias ("gets"); opts->weakref("popen");']) {
    assert.deepEqual(sourceFindings("a.cpp", code), [], code);
  }
  // The C17, C23 and C++ readings of a header are united, not reported three times.
  assert.equal(sourceFindings("a.h", "strcpy(a, b);").length, 1);
  // A lone CR ends a line for the compiler, so it ends one for attribution too.
  assert.equal(sourceFindings("a.cpp", "int a;\rint b;\rstrcpy(d, s);\r")[0].line, 3);
});

test("script masking is linear and a stray quote no longer hides later lines", () => {
  const started = performance.now();
  sourceFindings("a.js", "/* ".repeat(700_000));
  sourceFindings("a.js", '"\\"'.repeat(400_000) + "\\");
  sourceFindings("a.js", "`" + "\\a".repeat(1 << 20));
  sourceFindings("a.js", "x`\n".repeat(700_000));
  sourceFindings("a.cpp", "scanf(".repeat(350_000));
  assert.ok(performance.now() - started < 20_000);
  // Repeated calls on one line: each match looks back only over its own whitespace.
  const evaluations = performance.now();
  assert.equal(sourceFindings("a.js", "eval(x);".repeat(262_144)).length, 1);
  assert.deepEqual(sourceFindings("a.js", "a.eval(x);".repeat(52_429)), []);
  assert.ok(performance.now() - evaluations < 5_000);
  // `eval` before 2 MiB of blanks, of a comment the masker blanks, or of line ends, with no
  // `(` after them: the blanks are read once, not once per split between two `\s*`.
  // (128 KiB took 8 s that way, so it is tried first.)
  for (const size of [1 << 17, 1 << 21]) {
    for (const run of [" ".repeat(size), "/*" + "*".repeat(size) + "*/", "\n".repeat(size), "?." + " ".repeat(size)]) {
      const started = performance.now();
      assert.deepEqual(sourceFindings("a.js", `eval${run}x;\n`), []);
      assert.ok(performance.now() - started < 2_000, `${JSON.stringify(run.slice(0, 2))} ${size}: ${performance.now() - started} ms`);
    }
  }
  assert.equal(sourceFindings("a.js", "eval ?. \n (input)")[0]?.rule, "web.dynamic-code");
  assert.equal(sourceFindings("a.js", "eval /* x */ (input)")[0]?.rule, "web.dynamic-code");
  assert.equal(sourceFindings("a.js", 'const r = /"/;\neval(input);\nconst s = "";')[0]?.line, 2);
  // A `/*` or backtick that never closes (here inside a regular-expression literal) hides
  // only its own line; a block comment or template that does close is still masked.
  assert.equal(sourceFindings("a.js", 'const r = s.replace(/\\/*$/, "");\neval(input);')[0]?.line, 2);
  assert.equal(sourceFindings("a.js", 'const t = s.replace(/`/g, "");\neval(input);')[0]?.line, 2);
  assert.equal(sourceFindings("a.js", "s.split(/```/);\neval(input);")[0]?.line, 2);
  assert.equal(sourceFindings("a.js", "/* open\neval(input);")[0]?.line, 2);
  assert.equal(sourceFindings("a.ts", 'const md = s.replace(/`/g, "");\nexec(req.body.cmd);\n')[0]?.rule, "web.request-to-shell");
  assert.deepEqual(sourceFindings("a.js", "const u = /\\/*$/;\nconst v = `multi\nline eval(x)`;\nconst w = 1;"), []);
  assert.deepEqual(sourceFindings("a.js", "const r = /`/;\n/* multi\nline eval(x) */\nconst w = 1;"), []);
  assert.equal(sourceFindings("a.js", "const r = /`/;\n/* multi\nline eval(x) */\neval(input);")[0]?.line, 4);
});

test("Objective-C/C++, C++ module units and inline headers are policy sources", () => {
  for (const file of ["a.mm", "a.m", "a.cppm", "a.ixx", "a.mpp", "a.inl", "a.ipp", "a.tpp", "a.h++", "a.c++", "a.inc", "a.def"]) {
    assert.equal(sourceFindings(file, "void f() { strcpy(a, b); }")[0]?.rule, "native.unbounded-copy", file);
  }
  assert.deepEqual(sourceFindings("notes.txt", "strcpy(a, b);"), []);
  // An included fragment is read like a header (C rules too) but never compiled alone,
  // and only where a compiler reads it: `.inc` is also PHP, assembler or Pascal.
  assert.equal(sourceFindings("ops.inc", '#define R\nR"(x"; int r = system(c); //)";')[0]?.rule, "native.command-execution");
  assert.ok(isNativeFragment("ops.inc") && !isNativeHeader("ops.inc") && !isTranslationUnit("colors.def"));
  assert.ok(!isPolicySource("ops.inc") && !isPolicySource("colors.def") && isPolicySource("ops.inl"));
  // Clang and GCC compile `.M` as Objective-C++ and `.C` as C++, so a raw string there is one
  // literal: the call after it is code.
  for (const file of ["a.M", "a.C", "a.mm"]) {
    assert.equal(sourceFindings(file, 'void f(char* a, const char* b) {\n  auto s = R"x( " )x"; strcpy(a, b);\n}')[0]?.rule,
      "native.unbounded-copy", file);
  }
  // MSVC and DOS-era code compile `.C` as C, so `.C` and `.M` are read in the C readings too,
  // like a header: there `R` is a macro and the call after the string is code, and a
  // trigraph joins `str` and `cpy`. A C++ file has neither reading.
  const macroR = '#define R\nR"(x"; int r = system(c); //)";', trigraph = "void f(char *d, const char *s) { str??/\ncpy(d, s); }";
  for (const file of ["a.C", "a.M", "a.h"]) {
    assert.deepEqual([sourceFindings(file, macroR)[0]?.rule, sourceFindings(file, trigraph)[0]?.rule],
      ["native.command-execution", "native.trigraph"], file);
  }
  for (const file of ["a.cpp", "a.mm", "a.CPP"]) assert.deepEqual([...sourceFindings(file, macroR), ...sourceFindings(file, trigraph)], [], file);
  // A configured `.C` or `.M` is read in the language its standard declares: C++ has no
  // trigraph and no C17 reading of a digit separator, and C no raw string.
  const date = "// Shows ??/??/???? while the date is unknown.\nint show(void);\n";
  const separated = "int limit() { return 1'000; } // don't use strcpy(d, s) here\n";
  const raw = 'void f(char* a, const char* b) {\n  auto s = R"x( " )x"; strcpy(a, b);\n}';
  for (const file of ["a.C", "a.M"]) {
    assert.deepEqual([date, separated, raw].map(source => sourceFindings(file, source, false)[0]?.rule),
      [undefined, undefined, "native.unbounded-copy"], file);
    assert.deepEqual([date, separated, raw, macroR].map(source => sourceFindings(file, source, true)[0]?.rule),
      ["native.trigraph", "native.unbounded-copy", undefined, "native.command-execution"], file);
    assert.deepEqual([date, separated, raw].map(source => sourceFindings(file, source)[0]?.rule),
      ["native.trigraph", "native.unbounded-copy", "native.unbounded-copy"], file);
  }
  for (const file of ["a.h", "a.cpp", "a.c"]) {
    assert.deepEqual([true, false].map(c => sourceFindings(file, date, c).length), [file === "a.cpp" ? 0 : 1, file === "a.cpp" ? 0 : 1], file);
  }
  // Only the lowercase `.m` and `.c` are C languages by extension; `.C` and `.M` take the
  // language of a unit's declared standard.
  assert.ok(isCLanguageUnit("a.m") && isCLanguageUnit("a.c") && !isCLanguageUnit("a.M") && !isCLanguageUnit("a.C"));
  assert.deepEqual(["a.C", "a.M", "a.c", "a.m", "a.CPP", "a.MM", "a.Cc"].map(isEitherLanguageUnit), [true, true, false, false, false, false, false]);
  assert.deepEqual([["a.C", true], ["a.C", false], ["a.M", true], ["a.M", false], ["a.c", true], ["a.m", true], ["a.mm", false]]
    .map(([file, c]) => unitLanguage(file, c)), ["c", "c++", "objective-c", "objective-c++", "c", "objective-c", "objective-c++"]);
});

test("unconfigured native sources and failed collection never become passes", async (t) => {
  const root = fixture(t);
  const result = await scanRepository({ root, collect: () => [{ file: "a.cpp", source: "int main(){}" }] });
  assert.equal(result.status, "error");
  assert.equal(result.checks[0].rule, "native.configuration-required");
  const unreadable = await scanRepository({ root, collect: () => { throw new Error("SECRET"); } });
  assert.equal(unreadable.status, "error");
  assert.equal(JSON.stringify(unreadable).includes("SECRET"), false);
});

test("JS evaluation keeps bare and global calls blocked without conflating Redis methods or TS declarations", () => {
  for (const code of ["eval(input)", "new Function(input)", "Function(input)",
    "globalThis.eval(input)", "window . eval(input)", "self.eval(input)",
    "global.eval(input)", "globalThis?.eval?.(input)", "eval?.(input)",
    "window.Function(input)", "eval({ script: input })", "eval(flag ? a : b)",
    "globalThis /* receiver */ . /* member */ eval(input)",
    // However long the masked comment or layout between the receiver and the call.
    "window/*" + "c".repeat(300) + "*/.eval(code)", "globalThis" + " ".repeat(400) + ".eval(code)"]) {
    assert.equal(sourceFindings("source.ts", code)[0]?.rule, "web.dynamic-code", code);
  }
  for (const code of ["await redis.eval(SCRIPT, 1, key)",
    "await this.client.eval(SCRIPT, 2, first, second)",
    "interface RedisPort { eval(script: string, numKeys: number): Promise<unknown>; }",
    "class Fake { async eval(script: string, numKeys: number) { return 1; } }"]) {
    assert.deepEqual(sourceFindings("source.ts", code), [], code);
  }
  assert.equal(sourceFindings("source.ts", "redis.eval(SCRIPT);\neval(input)")[0].line, 2);
});

test("finding flood is bounded and remains a failing inspection", () => {
  const findings = sourceFindings("flood.js", "eval(input);\n".repeat(1000));
  assert.equal(findings.length, 201);
  assert.equal(findings.at(-1).rule, "inspection.finding-limit");
  assert.equal(findings[199].line, 200);
});

test("native analysis uses fixed compiler arguments, reports warning-only failures and missing compiler", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const unit = { file: "unit.cpp", standard: "c++20", defines: ["FEATURE=1"], includes: ["."] };
  const command = nativeInvocation(root, unit);
  assert.equal(command.command, "clang++");
  // `--analyze` makes the clang driver add -w, so warnings need their own pass.
  const [diagnostics, expansion, analyzer] = command.passes;
  assert.ok(diagnostics.includes("-fsyntax-only") && diagnostics.includes("-Werror"));
  assert.ok(analyzer.includes("--analyze") && !analyzer.includes("-fsyntax-only"));
  // Paths end at functions declared noreturn, not at a fixed list of names (Windows keeps
  // the list for the UCRT's assert handler, which is not declared noreturn).
  assert.equal(analyzer.includes("-analyzer-disable-checker=security.insecureAPI.DeprecatedOrUnsafeBufferHandling,"
    + "core.builtin.NoReturnFunctions"), process.platform !== "win32");
  // The expansion pass prints the preprocessed unit to the process, never into a file.
  assert.ok(expansion.includes("-E") && !expansion.includes("-o") && !expansion.includes("--analyze"));
  assert.equal(command.passes.length, 3);
  for (const args of command.passes) assert.deepEqual(args.slice(args.indexOf("-x"), args.indexOf("-x") + 2), ["-x", "c++"]);
  // A crash's status is "error" either way, so only the argument shows the reproducer is off.
  for (const args of command.passes) assert.ok(args.includes("-fno-crash-diagnostics"));
  // Nothing is defined for analysis that the product build lacks: a unit could test it.
  for (const args of command.passes) {
    assert.deepEqual(args.filter(arg => arg.startsWith("-D")), ["-DFEATURE=1"]);
  }
  // The diagnostics pass lists what it read in a file outside the checkout.
  const listed = nativeInvocation(root, unit, {}, null, { dependencies: "/elsewhere/0.d" }).passes;
  assert.deepEqual(listed[0].slice(listed[0].indexOf("-MD"), listed[0].indexOf("-MD") + 5), ["-MD", "-MF", "/elsewhere/0.d", "-MT", "praesidium"]);
  assert.ok(!listed[1].includes("-MD") && !listed[2].includes("-MD"));
  // A probe only preprocesses, without linemarkers, which tells it from the expansion pass.
  writeFileSync(join(root, "kit.hpp"), "#pragma once\n");
  const probed = nativeInvocation(root, unit, {}, "kit.hpp", { probe: true });
  assert.deepEqual(probed.passes[0].slice(0, 5), ["-E", "-P", "-w", "-x", "c++-header"]);
  // Its syntax checks only parse, without warnings: in the unit's language, then as
  // Objective-C with blocks. Other invocations have none.
  assert.deepEqual(probed.syntax.map(args => args.slice(0, args.indexOf("-x") + 2)),
    [["-fsyntax-only", "-w", "-x", "c++-header"], ["-fsyntax-only", "-w", "-fblocks", "-x", "objective-c++-header"]]);
  assert.equal(command.syntax, undefined);
  assert.throws(() => nativeInvocation(root, { ...unit, defines: ["X -Xclang -load evil"] }));
  assert.throws(() => nativeInvocation(root, { ...unit, includes: [".."] }));
  const sources = [{ file: "unit.cpp" }];
  assert.equal((await analyzeNative(root, sources, [unit], async () => ({ ok: true, exitCode: 0, diagnostics: true })))[0].status, "failed");
  assert.equal((await analyzeNative(root, sources, [unit], async () => ({ ok: false, exitCode: null })))[0].status, "error");
});

test("safe supported code reports limited coverage, not whole-program security", async (t) => {
  const root = fixture(t);
  const result = await scanRepository({ root, collect: () => [{ file: "a.js", source: "export const sum = (a,b) => a+b;" }] });
  assert.equal(result.status, "passed");
  assert.equal(result.coverage.webRuntimeWiring, "not-verified");
  assert.equal(result.coverage.webContracts, 0);
  writeFileSync(join(root, "praesidium.json"), '{"version":1,"unknown":true}');
  assert.equal((await scanRepository({ root, collect: () => [] })).status, "error");
});

test("host-owned packages resolve without running repository setup or accepting external PR paths", (t) => {
  const root = fixture(t), hostRoot = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const compiler = join(hostRoot, "compiler");
  writeFileSync(compiler, "fixture only; never executed");
  const configPath = join(hostRoot, "praesidium.host.json");
  const env = { REVISOR_CONFIG_PATH: join(hostRoot, "revisor.config.json") };
  const config = { version: 1, compilers: { cpp: compiler }, includePackages: { tela: hostRoot } };
  writeFileSync(configPath, JSON.stringify(config));
  const host = readNativeHost(root, env);
  const unit = { file: "unit.cpp", standard: "c++20", packages: ["tela"] };
  const invocation = nativeInvocation(root, unit, host);
  assert.equal(invocation.command, compiler);
  // Host libraries are system headers: their own warnings are not the reviewed change's.
  for (const args of invocation.passes) assert.equal(args[args.indexOf(realpathSync(hostRoot)) - 1], "-isystem");
  assert.throws(() => nativeInvocation(root, { ...unit, includes: [hostRoot] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["missing"] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["../tela"] }, host));
  assert.throws(() => nativeInvocation(root, { ...unit, packages: ["tela", "tela"] }, host));
  writeFileSync(configPath, JSON.stringify({ ...config, includePackages: { tela: "relative" } }));
  assert.throws(() => readNativeHost(root, env));
  writeFileSync(join(root, "praesidium.host.json"), JSON.stringify(config));
  assert.throws(() => readNativeHost(root, { REVISOR_CONFIG_PATH: join(root, "config.json") }));
});

test("missing host packages fail before any compiler is started", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  const units = [{ file: "unit.cpp", standard: "c++20", packages: ["uninstalled"] }];
  let calls = 0;
  await assert.rejects(analyzeNative(root, [{ file: "unit.cpp" }], units,
    async () => { calls++; return { ok: true }; }, { host: {} }));
  assert.equal(calls, 0);
});

test("native batch keeps at most two compilers alive and reports all units in input order", async () => {
  let active = 0, peak = 0;
  const units = Array.from({ length: 7 }, (_, index) => ({ file: `${index}.cpp`, command: "fixture", passes: [[index]], cwd: "." }));
  const outcomes = await analyzeNativeBatch(units, async (_command, [index]) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (index === 2) throw new Error("private compiler failure");
    return { ok: true, exitCode: 0, diagnostics: index === 4 };
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(outcomes.map(item => item.file), units.map(item => item.file));
  assert.deepEqual(outcomes.map(item => item.status), ["passed", "passed", "error", "passed", "failed", "passed", "passed"]);
  assert.ok(!JSON.stringify(outcomes).includes("private compiler failure"));
});

test("expired native scheduling budget explicitly reports every unstarted unit", async () => {
  let clock = 0, calls = 0;
  const units = ["a", "b", "c"].map(file => ({ file, command: "fixture", passes: [[]], cwd: "." }));
  const outcomes = await analyzeNativeBatch(units, async () => {
    calls++; clock = 1_000_000;
    return { ok: true, exitCode: 0 };
  }, () => clock);
  assert.equal(calls, 1);
  assert.deepEqual(outcomes.map(item => item.status), ["passed", "error", "error"]);
  assert.equal(outcomes[1].rule, "native.analysis-budget");
  assert.equal(outcomes[2].rule, "native.analysis-budget");
});

test("a file whose analyzer pass would start after the budget is a budget error, not a pass", async () => {
  let clock = 0;
  const started = [];
  const outcomes = await analyzeNativeBatch([{ file: "unit.cpp", command: "fixture", passes: [["diagnostics"], ["analyzer"]], cwd: "." }],
    async (_command, [pass]) => { started.push(pass); clock = 1_000_000; return { ok: true, exitCode: 0 }; }, () => clock);
  assert.deepEqual(started, ["diagnostics"]);
  assert.deepEqual(outcomes, [{ rule: "native.analysis-budget", file: "unit.cpp", status: "error" }]);
});

test("the native budget counts compiler processes, not files", async () => {
  // 8 two-pass files = 16 processes: (8 + 1) * 60s; counting files would allow (4 + 1) * 60s.
  let clock = 0, calls = 0;
  const units = Array.from({ length: 8 }, (_, index) => ({
    file: `unit-${index}.cpp`, command: "fixture", passes: [["diagnostics"], ["analyzer"]], cwd: ".",
  }));
  const outcomes = await analyzeNativeBatch(units, async () => { calls++; clock += 30_000; return { ok: true, exitCode: 0 }; }, () => clock);
  assert.equal(calls, 16);
  assert.ok(outcomes.every(check => check.rule === "native.clang-analysis" && check.status === "passed"));
});

test("a probe that does not compile reports the file as not analyzed; any other failure stays a failure", async () => {
  const probe = { file: "kit.hpp", command: "fixture", passes: [["probe"], ["diagnostics"], ["analyzer"]], cwd: ".", probe: true };
  const run = results => analyzeNativeBatch([probe], async (_command, [pass]) => results[pass]);
  assert.deepEqual(await run({ probe: { ok: false, exitCode: 1 } }), [{ rule: "native.not-analyzed", file: "kit.hpp", status: "skipped" }]);
  assert.equal((await run({ probe: { ok: false, exitCode: null } }))[0].status, "error");
  assert.equal((await run({ probe: { ok: true, exitCode: 0 }, diagnostics: { ok: false, exitCode: 1 } }))[0].status, "failed");
  assert.equal((await run({ probe: { ok: true, exitCode: 0 }, diagnostics: { ok: true, exitCode: 0 }, analyzer: { ok: true, exitCode: 0 } }))[0].status, "passed");
  // When the diagnostics pass fails, a file that parses only as Objective-C is not analyzed;
  // one that parses in its own language without warnings, or in neither, failed.
  const checked = { ...probe, syntax: [["own"], ["objective-c"]] };
  const verdict = async results => (await analyzeNativeBatch([checked], async (_command, [pass]) => results[pass]))[0];
  const failing = { probe: { ok: true, exitCode: 0 }, diagnostics: { ok: false, exitCode: 1 } };
  const no = { ok: false, exitCode: 1 }, yes = { ok: true, exitCode: 0 };
  assert.deepEqual(await verdict({ ...failing, own: no, "objective-c": yes }), { rule: "native.not-analyzed", file: "kit.hpp", status: "skipped" });
  assert.equal((await verdict({ ...failing, own: yes, "objective-c": yes })).status, "failed");
  assert.equal((await verdict({ ...failing, own: no, "objective-c": no })).status, "failed");
  assert.equal((await verdict({ ...failing, own: { ok: false, exitCode: null }, "objective-c": yes })).status, "error");
  assert.equal((await verdict({ ...failing, own: no, "objective-c": { ok: true, exitCode: 0, diagnostics: true } })).status, "failed");
  // The checks run only after a failing diagnostics pass, and count toward the budget.
  const calls = [];
  await analyzeNativeBatch([checked], async (_command, [pass]) => { calls.push(pass); return yes; });
  assert.deepEqual(calls, ["probe", "diagnostics", "analyzer"]);
  // Five processes: a (3 + 1) * 60 s budget, which four 70 s processes stay within and
  // three 100 s ones exceed before the Objective-C check.
  const steps = { probe: yes, diagnostics: no, own: no, "objective-c": yes };
  const timed = async step => {
    let clock = 0;
    return analyzeNativeBatch([checked], async (_command, [pass]) => { clock += step; return steps[pass]; }, () => clock);
  };
  assert.equal((await timed(70_000))[0].status, "skipped");
  assert.deepEqual(await timed(100_000), [{ rule: "native.analysis-budget", file: "kit.hpp", status: "error" }]);
});

test("large native batches inspect every unit beyond the old two-minute cutoff", async () => {
  let clock = 0, calls = 0;
  const units = Array.from({ length: 8 }, (_, index) => ({
    file: `unit-${index}.cpp`, command: "fixture", passes: [[]], cwd: ".",
  }));
  const outcomes = await analyzeNativeBatch(units, async () => {
    calls++; clock += 25_000;
    return { ok: true, exitCode: 0 };
  }, () => clock);
  assert.equal(calls, units.length);
  assert.equal(outcomes.length, units.length);
  assert.ok(outcomes.every(check => check.status === "passed"));
});

test("changed-scope review does not require units for unchanged native files", async (t) => {
  const root = fixture(t);
  const collect = () => [{ file: "legacy.cpp", source: "int f() { return 0; }" },
    { file: "legacy.h", source: "int f();" }, { file: "app.js", source: "export const one = 1;" }];
  const result = await scanRepository({ root, collect, changedPaths: ["app.js"] });
  assert.equal(result.status, "passed");
  assert.equal(result.coverage.nativeScope, "changed");
  assert.equal(result.coverage.nativeUnits, 0);
});

test("changed translation units and headers still require native configuration", async (t) => {
  const root = fixture(t);
  const sources = [{ file: "legacy.cpp" }, { file: "changed.cpp" }, { file: "changed.h" }];
  const units = [{ file: "legacy.cpp", standard: "c++20" }];
  const missing = await analyzeNative(root, sources, units, async () => assert.fail("must not compile"),
    { changed: new Set(["changed.cpp"]) });
  assert.deepEqual(missing, [{ rule: "native.configuration-required", status: "error" }]);
  const header = await analyzeNative(root, sources, [], async () => assert.fail("must not compile"),
    { changed: new Set(["changed.h"]) });
  assert.equal(header[0].rule, "native.configuration-required");
  const scanned = await scanRepository({ root, collect: () => [{ file: "changed.cpp", source: "int main(){}" }],
    changedPaths: ["changed.cpp"] });
  assert.equal(scanned.status, "error");
  assert.equal(scanned.checks[0].rule, "native.configuration-required");
});

test("only configured units for changed files are compiled; unchanged units are shape-checked", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "changed.cpp"), "int main() {}\n");
  const sources = [{ file: "changed.cpp" }, { file: "unchanged.cpp" }];
  const units = [{ file: "changed.cpp", standard: "c++20" }, { file: "unchanged.cpp", standard: "c++17" }];
  const compiled = [];
  const outcomes = await analyzeNative(root, sources, units, async (_command, args) => {
    compiled.push(args.at(-1));
    return { ok: true, exitCode: 0 };
  }, { host: {}, changed: new Set(["changed.cpp"]) });
  assert.deepEqual(outcomes.map(item => item.file), ["changed.cpp"]);
  assert.deepEqual(compiled, [join(root, "changed.cpp"), join(root, "changed.cpp"), join(root, "changed.cpp")]);
  await assert.rejects(analyzeNative(root, sources, [units[0], { file: "unchanged.cpp", standard: "c++98" }],
    async () => assert.fail("must not compile"), { host: {}, changed: new Set(["changed.cpp"]) }));
});

test("the 256-unit cap applies to analyzed units, not to the configuration length", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "legacy"));
  const files = ["changed.cpp", ...Array.from({ length: 299 }, (_, index) => `legacy/${index}.cpp`)];
  // Real files, so only the limit (not a missing file) can reject the larger set.
  for (const file of files) writeFileSync(join(root, file), "int main() {}\n");
  const sources = files.map(file => ({ file }));
  const units = files.map(file => ({ file, standard: "c++20" }));
  let calls = 0;
  const outcomes = await analyzeNative(root, sources, units, async () => { calls++; return { ok: true, exitCode: 0 }; },
    { host: {}, changed: new Set(["changed.cpp"]) });
  assert.equal(calls, 3);
  assert.equal(outcomes[0].status, "passed");
  await assert.rejects(analyzeNative(root, sources, units, async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(files) }), /native analysis unit limit/);
  // Changed headers count too: 256 units and one header are 257 analyzed files.
  writeFileSync(join(root, "legacy/h.hpp"), "int g();\n");
  const capped = files.slice(0, 256);
  const withHeader = [...capped.map(file => ({ file })), { file: "legacy/h.hpp", source: "int g();\n" }];
  await assert.rejects(analyzeNative(root, withHeader, capped.map(file => ({ file, standard: "c++20" })),
    async () => assert.fail("must not compile"), { host: {}, changed: new Set([...capped, "legacy/h.hpp"]) }), /native analysis unit limit/);
  const fits = await analyzeNative(root, withHeader.slice(1), capped.slice(1).map(file => ({ file, standard: "c++20" })),
    async () => ({ ok: true, exitCode: 0 }), { host: {}, changed: new Set([...capped.slice(1), "legacy/h.hpp"]) });
  assert.equal(fits.length, 256);
  // So do units compiled for a changed fragment: the root unit sees it by directory and
  // legacy/0.cpp includes it, so 255 changed units and those 2 are 257.
  const changedUnits = files.slice(2, 257);
  const fragment = files.map(file => ({ file, source: file === "legacy/0.cpp" ? '#include "../gen/ops.inc"\n' : "" }));
  await assert.rejects(analyzeNative(root, fragment, units, async () => assert.fail("must not compile"),
    { host: {}, changed: new Set([...changedUnits, "gen/ops.inc"]) }), /native analysis unit limit/);
  const fragmentFits = await analyzeNative(root, fragment, units, async () => ({ ok: true, exitCode: 0 }),
    { host: {}, changed: new Set([...changedUnits.slice(1), "gen/ops.inc"]) });
  assert.equal(fragmentFits.length, 256);
  // Checking 30,000 configured units against the tracked ones is linear: about 50 ms, where
  // searching one list for each entry of the other took 0.8 s for the tracked files and
  // 1 to 3 s for the configured ones.
  const many = Array.from({ length: 30_000 }, (_, index) => ({ file: `src/u${index}.c` }));
  const started = performance.now();
  await assert.rejects(analyzeNative(root, many, many.map(({ file }) => ({ file, standard: "c17" })),
    async () => assert.fail("must not compile"), { host: {} }), /native analysis unit limit/);
  assert.ok(performance.now() - started < 400, `${performance.now() - started} ms`);
});

test("an unknown change set falls back to whole-repository native requirements", async (t) => {
  const root = fixture(t);
  const collect = () => [{ file: "legacy.cpp", source: "int f() { return 0; }" }, { file: "app.js", source: "export const one = 1;" }];
  for (const changedPaths of [undefined, null, "app.js", [42]]) {
    const result = await scanRepository({ root, collect, changedPaths });
    assert.equal(result.status, "error");
    assert.equal(result.checks[0].rule, "native.configuration-required");
  }
  const whole = await analyzeNative(root, [{ file: "legacy.cpp" }], [], async () => assert.fail("must not compile"));
  assert.equal(whole[0].rule, "native.configuration-required");
});

// These run the real compiler: a stubbed executor cannot show that a flag takes effect
// (the driver's `-w` for `--analyze` once silenced every warning flag unnoticed).
function clangAvailable() {
  try { execFileSync("clang++", ["--version"], { stdio: "ignore", windowsHide: true }); return true; }
  catch { return false; }
}

async function analyzeWithClang(t, files, units, changed, findings = undefined) {
  const root = fixture(t);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const sources = Object.keys(files).map(file => ({ file }));
  const outcomes = await analyzeNative(root, sources, units, undefined, { host: {}, changed: changed && new Set(changed), findings });
  // Analysis never writes into the reviewed checkout (no PCH, plist or crash reproducer).
  const written = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath ?? entry.path, entry.name)).replaceAll("\\", "/")).filter(file => !file.startsWith(".git/"));
  assert.deepEqual(written.sort(), Object.keys(files).sort());
  return outcomes;
}

test("real clang: compiler warnings fail a unit even though the analyzer runs with -w", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const unit = { file: "log.cpp", standard: "c++20" };
  const formatString = await analyzeWithClang(t, { "log.cpp": "#include <cstdio>\nvoid log(const char* m) { std::printf(m); }\n" }, [unit]);
  assert.equal(formatString[0].status, "failed");
  const dangling = await analyzeWithClang(t, { "log.cpp": "#include <string>\n#include <string_view>\nstd::string_view name() { return std::string(\"tmp\"); }\n" }, [unit]);
  assert.equal(dangling[0].status, "failed");
  const clean = await analyzeWithClang(t, { "log.cpp": "#include <cstdio>\nvoid log(const char* m) { std::fputs(m, stderr); }\n" }, [unit]);
  assert.equal(clean[0].status, "passed");
});

test("real clang: analyzer findings in units, module units and changed headers fail", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const useAfterFree = "int read(int n) { int* p = new int[4](); delete[] p; return p[n]; }\n";
  for (const file of ["codec.cpp", "codec.cppm", "codec.ixx", "codec.c++"]) {
    const outcomes = await analyzeWithClang(t, { [file]: useAfterFree }, [{ file, standard: "c++20" }]);
    assert.equal(outcomes[0].status, "failed", file);
  }
  // A header-only change compiles the header itself with a unit that can see it.
  const files = {
    "src/flv.cpp": "#include \"bytes.hpp\"\nint use() { return 0; }\n",
    "src/bytes.hpp": `#pragma once\nstruct Frame { ${useAfterFree.replace("int read", "int copy")} };\n`,
  };
  const units = [{ file: "src/flv.cpp", standard: "c++20" }];
  const header = await analyzeWithClang(t, files, units, ["src/bytes.hpp"]);
  assert.deepEqual(header.map(item => [item.file, item.status]), [["src/bytes.hpp", "failed"]]);
  const fixed = await analyzeWithClang(t, { ...files, "src/bytes.hpp": "#pragma once\nstatic int helper() { return 1; }\nstatic const int table[2] = {1, 2};\n" }, units, ["src/bytes.hpp"]);
  assert.deepEqual(fixed.map(item => item.status), ["passed"]);
  // Each passes the diagnostics pass, so only the opt-in analyzer checkers can fail them.
  const uninit = "struct Header { int length; int flags; Header() : length(0) {} };\nint use() { Header h; return h.length; }\n";
  assert.equal((await analyzeWithClang(t, { "hdr.cpp": uninit }, [{ file: "hdr.cpp", standard: "c++20" }]))[0].status, "failed");
  const virtualCall = "struct Base { Base() { init(); } virtual ~Base() = default; virtual void init() {} };\n"
    + "struct Derived : Base { void init() override {} };\nint use() { Derived d; return 0; }\n";
  assert.equal((await analyzeWithClang(t, { "ctor.cpp": virtualCall }, [{ file: "ctor.cpp", standard: "c++20" }]))[0].status, "failed");
});

test("real clang: the baseline rejects unsafe APIs the syntactic rule cannot see, and module units still compile", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const unit = { file: "copy.cpp", standard: "c++23" };
  const aliased = "#include <cstring>\n#define COPY strcpy\nvoid f(char* d) { COPY(d, \"x\"); }\n";
  assert.deepEqual(sourceFindings(unit.file, aliased), []);
  assert.equal((await analyzeWithClang(t, { [unit.file]: aliased }, [unit]))[0].status, "failed");
  const pointer = "#include <cstdio>\nauto format = &std::sprintf;\n";
  assert.equal((await analyzeWithClang(t, { [unit.file]: pointer }, [unit]))[0].status, "failed");
  const bounded = "#include <cstdio>\nint f(char* d, int n) { return std::snprintf(d, 8, \"%d\", n); }\n";
  assert.equal((await analyzeWithClang(t, { [unit.file]: bounded }, [unit]))[0].status, "passed");
  const moduleUnit = { file: "codec.cppm", standard: "c++20" };
  const exported = "module;\n#include <cstddef>\nexport module codec;\nexport std::size_t width() { return 4; }\n";
  assert.equal((await analyzeWithClang(t, { [moduleUnit.file]: exported }, [moduleUnit]))[0].status, "passed");
});

test("a unit cannot define macros that disable its own analysis or rename rejected APIs", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  // `_WIN32` skips the baseline and the attribute spellings turn its deprecation into
  // another attribute.
  for (const define of ["__clang_analyzer__", "__clang_analyzer__=0", "PRAESIDIUM_BASELINE_H", "PRAESIDIUM_UNSAFE", "strcpy=copy",
    "sprintf", "_WIN32", "deprecated=nodiscard", "__deprecated__=__annotate__", "__attribute__=x", "__builtin_va_list=int",
    "__cplusplus=201703L", "__has_include", "__restrict", "__WCHAR_TYPE__=int", "wchar_t=int", "noexcept", "std=other"]) {
    assert.throws(() => nativeInvocation(root, { file: "unit.cpp", standard: "c++20", defines: [define] }),
      new RegExp(`unit\\.cpp: define ${define.split("=")[0]} overrides analysis controls`), define);
  }
  // The suppress attribute is found after expansion, so a define may spell the word.
  for (const define of ["suppress=quiet", "QUIET=suppress"]) {
    assert.ok(nativeInvocation(root, { file: "unit.cpp", standard: "c++20", defines: [define] }).passes[1].includes(`-D${define}`));
  }
  // Hardening is the product build's choice (AIFormat's LUDIARS_CXX_HARDENING presets emit
  // these, and RULE_CODE_CPP §C2.10 copies a build's defines into praesidium.json).
  const built = nativeInvocation(root, { file: "unit.cpp", standard: "c++26", defines: ["_GLIBCXX_ASSERTIONS",
    "_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE", "_MSVC_STL_HARDENING=1", "_FORTIFY_SOURCE=2",
    "NDEBUG", "_UNICODE", "FEATURE=1", "__STDC_FORMAT_MACROS"] });
  for (const args of built.passes) {
    assert.ok(args.includes("-D_GLIBCXX_ASSERTIONS") && args.includes("-D_MSVC_STL_HARDENING=1") && args.includes("-DNDEBUG"));
    assert.ok(args.includes("-D__STDC_FORMAT_MACROS"));
    // Analysis never optimizes, where glibc turns _FORTIFY_SOURCE into a #warning.
    assert.ok(!args.some(arg => arg.startsWith("-D_FORTIFY_SOURCE")));
  }
  assert.throws(() => nativeInvocation(root, { file: "unit.cpp", standard: "c23" }), /standard/);
  assert.throws(() => nativeInvocation(root, { file: "unit.c", standard: "c++20" }));
  // The report names the offending entry: a praesidium.json name, never source text.
  writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1, web: [],
    native: [{ file: "unit.cpp", standard: "c++20", defines: ["__clang_analyzer__=0"] }] }));
  const scanned = await scanRepository({ root, collect: () => [{ file: "unit.cpp", source: "int main() {}" }], changedPaths: [] });
  assert.equal(scanned.status, "error");
  assert.match(scanned.reason, /unit\.cpp: define __clang_analyzer__ overrides analysis controls/);
});

test("an uppercase .C or .M unit is compiled in the language of its declared standard", async (t) => {
  const root = fixture(t);
  for (const file of ["NAME.C", "VIEW.M", "unit.c", "unit.cpp", "view.m", "view.mm", "x.h"]) writeFileSync(join(root, file), "int f(void);\n");
  // Clang and GCC compile `.C` as C++, MSVC and DOS-era code as C: the standard decides.
  for (const [file, standard, command, language] of [["NAME.C", "c17", "clang", "c"], ["NAME.C", "c++17", "clang++", "c++"],
    ["VIEW.M", "c11", "clang", "objective-c"], ["VIEW.M", "c++20", "clang++", "objective-c++"]]) {
    const invocation = nativeInvocation(root, { file, standard });
    assert.deepEqual([invocation.command, ...new Set(invocation.passes.map(args => args[args.indexOf("-x") + 1]))], [command, language], file);
  }
  const probed = nativeInvocation(root, { file: "NAME.C", standard: "c17" }, {}, "x.h", { probe: true });
  assert.deepEqual(probed.syntax.map(args => args[args.indexOf("-x") + 1]), ["c-header", "objective-c-header"]);
  // Every other extension keeps its own language.
  for (const [file, standard] of [["unit.c", "c++20"], ["unit.cpp", "c17"], ["view.m", "c++17"], ["view.mm", "c17"]]) {
    assert.throws(() => nativeInvocation(root, { file, standard }), /standard/, file);
  }
  // A header gets a unit of its language by the declared standard, whatever the order.
  const cUnit = { file: "src/NAME.C", standard: "c17", includes: ["include"] };
  const cxxUnit = { file: "src/APP.C", standard: "c++20", includes: ["include"] };
  for (const units of [[cUnit, cxxUnit], [cxxUnit, cUnit]]) {
    assert.equal(headerUnit("include/c.h", units, null), cUnit);
    assert.equal(headerUnit("include/x.hpp", units, "c++"), cxxUnit);
    assert.deepEqual(headerUnits("include/d.h", units, "c-and-c++"), [cUnit, cxxUnit]);
    assert.equal(headerUnit("include/n.h", units, "c23-or-c++"), cxxUnit);
  }
  assert.equal(headerUnit("include/x.hpp", [cUnit], "c++"), null);
  assert.equal(headerUnit("include/n.h", [cUnit, { ...cUnit, file: "src/NEW.C", standard: "c23" }], "c23-or-c++").file, "src/NEW.C");
  // The header languages each job compiles a changed header in.
  const compiledAs = async (sources, units, header) => {
    const languages = [];
    await analyzeNative(root, sources, units, async (_command, args) => {
      if (args.includes("-fsyntax-only") && !args.includes("-w")) languages.push(args[args.indexOf("-x") + 1]);
      return { ok: true, exitCode: 0 };
    }, { host: {}, changed: new Set([header]) });
    return languages;
  };
  mkdirSync(join(root, "mac"));
  writeFileSync(join(root, "mac/kit.h"), "@class NSView;\nint f(void);\n");
  writeFileSync(join(root, "mac/kit.hpp"), "@class NSView;\nnamespace k { int f(); }\n");
  const objectiveC = [{ file: "mac/A.M", standard: "c++20" }, { file: "mac/B.M", standard: "c17" }];
  const objectiveCSources = [...objectiveC.map(({ file }) => ({ file, source: "" })),
    { file: "mac/kit.h", source: "@class NSView;\nint f(void);\n" }, { file: "mac/kit.hpp", source: "@class NSView;\nnamespace k { int f(); }\n" }];
  for (const units of [objectiveC, [...objectiveC].reverse()]) {
    assert.deepEqual(await compiledAs(objectiveCSources, units, "mac/kit.h"), ["objective-c-header"]);
    assert.deepEqual(await compiledAs(objectiveCSources, units, "mac/kit.hpp"), ["objective-c++-header"]);
  }
  // Where only a file's name is known (an includer), a `.C` or `.M` counts as both a C and
  // a C++ reader: a C header with C++ linkage that only a `.C` includes gets both jobs.
  mkdirSync(join(root, "include"));
  const linkage = '#ifdef __cplusplus\nextern "C" {\n#endif\nchar *b(void);\n#ifdef __cplusplus\n}\n#endif\n';
  writeFileSync(join(root, "include/b.h"), linkage);
  mkdirSync(join(root, "src"));
  for (const file of ["src/a.c", "src/b.cpp"]) writeFileSync(join(root, file), "int g;\n");
  const portable = [{ file: "src/a.c", standard: "c17", includes: ["include"] }, { file: "src/b.cpp", standard: "c++20", includes: ["include"] }];
  const linkageSources = (includer) => [{ file: "src/a.c", source: "" }, { file: "src/b.cpp", source: "" },
    { file: includer, source: '#include "b.h"\n' }, { file: "include/b.h", source: linkage }];
  for (const includer of ["src/MAIN.C", "src/MAIN.M"]) {
    assert.deepEqual(await compiledAs(linkageSources(includer), portable, "include/b.h"), ["c-header", "c++-header"], includer);
  }
  assert.deepEqual(await compiledAs(linkageSources("src/main.c"), portable, "include/b.h"), ["c-header"]);
  assert.deepEqual(await compiledAs(linkageSources("src/main.cpp"), portable, "include/b.h"), ["c++-header"]);
  // A configured `.C` or `.M` counts in the language its standard declares, like a `.c` or
  // `.cpp`: a C one makes no C++ reader of the C header with C++ linkage it alone includes,
  // and a C++ one makes a marker-free header that it alone includes a C++ one.
  for (const includer of ["src/MAIN.C", "src/MAIN.M"]) {
    writeFileSync(join(root, includer), "int g;\n");
    const declared = (standard) => [...portable, { file: includer, standard, includes: ["include"] }];
    assert.deepEqual(await compiledAs(linkageSources(includer), declared("c17"), "include/b.h"), ["c-header"], includer);
    assert.deepEqual(await compiledAs(linkageSources(includer), declared("c++20"), "include/b.h"), ["c++-header"], includer);
  }
  const point = "struct Point { int x, y; };\nstatic inline int sum(struct Point p) { return p.x + p.y; }\n";
  writeFileSync(join(root, "include/point.h"), point);
  const pointSources = [{ file: "src/a.c", source: "" }, { file: "src/APP.C", source: '#include "point.h"\n' }, { file: "include/point.h", source: point }];
  writeFileSync(join(root, "src/APP.C"), "int g;\n");
  const app = { file: "src/APP.C", standard: "c++20", includes: ["include"] };
  for (const units of [[portable[0], app], [app, portable[0]]]) {
    assert.deepEqual(await compiledAs(pointSources, units, "include/point.h"), ["c++-header"]);
  }
  assert.deepEqual(await compiledAs(pointSources, [portable[0], { ...app, standard: "c17" }], "include/point.h"), ["c-header"]);
  // The scan reads a configured `.C` or `.M` in its declared language; an unconfigured one,
  // or one whose entry is not valid, in every reading.
  const dated = "// Shows ??/??/???? while the date is unknown.\nint show(void);\n";
  writeFileSync(join(root, "src/DATE.C"), dated);
  const scanned = async (native) => {
    writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1, native, web: [] }));
    const result = await scanRepository({ root, collect: () => [{ file: "src/DATE.C", source: dated }], changedPaths: [],
      nativeExecute: async () => ({ ok: true, exitCode: 0 }), nativeHost: {} });
    return result.findings.map(item => item.rule);
  };
  assert.deepEqual(await scanned([{ file: "src/DATE.C", standard: "c++17" }]), []);
  assert.deepEqual(await scanned([{ file: "src/DATE.C", standard: "c17" }]), ["native.trigraph"]);
  assert.deepEqual(await scanned([]), ["native.trigraph"]);
  assert.deepEqual([...declaredLanguages([{ file: "a.C", standard: "c11" }, { file: "b.M", standard: "c++26" }, { file: "c.C", standard: "c++98" },
    { file: "d.c", standard: "c17" }, null, { file: 1 }])], [["a.C", true], ["b.M", false]]);
  assert.deepEqual([...declaredLanguages({})], []);
});


test("real clang: the baseline accepts bounded APIs in every supported C and C++ standard", { skip: !clangAvailable() && "clang++ is not installed" }, (t) => {
  const fixtures = fileURLToPath(new URL("./fixtures/praesidium-native", import.meta.url));
  const out = fixture(t);
  const compile = (compiler, standard, source) => execFileSync(compiler, ["-fsyntax-only", ...NATIVE_WARNINGS,
    `-std=${standard}`, "-include", NATIVE_BASELINE_HEADER, join(fixtures, source)], { cwd: out, stdio: "pipe", windowsHide: true });
  const compileUnit = (compiler, standard, file, extra = []) => execFileSync(compiler, ["-fsyntax-only", ...NATIVE_WARNINGS,
    `-std=${standard}`, ...extra, "-include", NATIVE_BASELINE_HEADER, join(out, file)], { cwd: out, stdio: "pipe", windowsHide: true });
  for (const standard of ["c11", "c17", "c23"]) compile("clang", standard, "bounded_apis.c");
  for (const standard of ["c++17", "c++20", "c++23", "c++2c"]) compile("clang++", standard, "bounded_apis.cpp");
  // The baseline includes nothing, so a unit's own feature macros and names come first.
  const units = {
    "posix.cpp": "#define _POSIX_C_SOURCE 200112L\n#include <unistd.h>\nint f() { return (int)getpid(); }\n",
    "index.cpp": "#include <vector>\n#include <string>\n#include <algorithm>\nstatic int index = 0;\nint f() { return index; }\n",
    "debug.cpp": "#define _GLIBCXX_DEBUG\n#include <vector>\nint f() { std::vector<int> v{1}; return v[0]; }\n",
    "null.c": "#define NULL 0\nint f(void) { int x = NULL; return x; }\n",
    "gnu.c": "#define _GNU_SOURCE\n#include <stdio.h>\n#include <wchar.h>\nint f(char* d) { return snprintf(d, 4, \"%d\", 1); }\n",
  };
  for (const [file, text] of Object.entries(units)) {
    writeFileSync(join(out, file), text);
    if (file.endsWith(".c")) for (const standard of ["c11", "c17", "c23"]) compileUnit("clang", standard, file);
    else for (const standard of ["c++17", "c++20", "c++23", "c++2c"]) compileUnit("clang++", standard, file);
  }
  writeFileSync(join(out, "unreachable.c"), "#include <stdlib.h>\nstatic _Noreturn void unreachable(void) { abort(); }\nint f(int x) { if (x) unreachable(); return 0; }\n");
  compileUnit("clang", "c23", "unreachable.c");
  // A C library without glibc's exception specification (musl, Apple, the BSDs) stays
  // compatible in C++, and the attribute still reaches the library's own declaration.
  mkdirSync(join(out, "libc"));
  writeFileSync(join(out, "libc/string.h"), '#pragma once\nextern "C" char *strcpy(char *__restrict, const char *__restrict);\n'
    + 'extern "C" char *strcat(char *__restrict, const char *__restrict);\n');
  writeFileSync(join(out, "other.cpp"), "#include <string.h>\nint f(char* d) { return d[0]; }\n");
  const other = ["-nostdinc", "-nostdinc++", "-isystem", join(out, "libc")];
  compileUnit("clang++", "c++20", "other.cpp", other);
  writeFileSync(join(out, "copy.cpp"), "#include <string.h>\nvoid f(char* d, const char* s) { auto c = &strcpy; c(d, s); }\n");
  assert.throws(() => compileUnit("clang++", "c++20", "copy.cpp", other), /Praesidium: unbounded copy/);
});


test("a crashing compiler is an incomplete inspection, not a finding about the unit", { skip: process.platform === "win32" && "uses a POSIX shell script as the compiler" }, async (t) => {
  const root = fixture(t);
  const crashing = join(root, "crashing-clang");
  writeFileSync(crashing, "#!/bin/sh\necho 'clang: error: clang frontend command failed with exit code 139' >&2\nexit 1\n", { mode: 0o755 });
  assert.equal((await analyzeProcess(crashing, [], root)).exitCode, null);
  const failing = join(root, "failing-clang");
  writeFileSync(failing, "#!/bin/sh\necho 'unit.cpp:1:1: error: unknown type name' >&2\nexit 1\n", { mode: 0o755 });
  const failed = await analyzeProcess(failing, [], root);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.diagnostics, true);
});

test("a passing diagnostics pass reports what it read, and one that cannot is incomplete", { skip: process.platform === "win32" && "uses a POSIX shell script as the compiler" }, async (t) => {
  const root = fixture(t);
  // clang's make syntax: `\ ` for a space, `\#` for `#`, `$$` for `$`, `\` + newline continues.
  assert.deepEqual(dependencyList("praesidium: /r/a.cpp \\\n  /r/qu\\ iet\\#$$1.txt \\\n  C:\\x\\y.h\n"),
    ["/r/a.cpp", "/r/qu iet#$1.txt", "C:\\x\\y.h"]);
  assert.throws(() => dependencyList("other: /r/a.cpp\n"));
  // Only a space or a line break separates names: clang writes a tab, a vertical tab or a
  // Unicode space raw inside a name, and doubles the backslashes before an escaped space.
  assert.deepEqual(dependencyList("praesidium: src/q\t/etc src/\v/etc src/\u00a0/etc a\\\\\\ b\r\n"),
    ["src/q\t/etc", "src/\v/etc", "src/\u00a0/etc", "a\\ b"]);
  const started = performance.now();
  for (const unit of ["\\", "\\ ", "$$", "\\#", "\t"]) dependencyList(`praesidium: ${unit.repeat(1024 * 1024)}`);
  assert.ok(performance.now() - started < 20_000);
  const listing = join(root, "listing-clang");
  writeFileSync(listing, '#!/bin/sh\nprintf \'praesidium: a.cpp \\\\\\n  inc/b.txt\\n\' > "$2"\n', { mode: 0o755 });
  assert.deepEqual((await analyzeProcess(listing, ["-MF", join(root, "out.d")], root)).dependencies, ["a.cpp", "inc/b.txt"]);
  const silent = join(root, "silent-clang");
  writeFileSync(silent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(await analyzeProcess(silent, ["-MF", join(root, "missing.d")], root), { ok: false, exitCode: null });
  // A failing pass's list only adds findings; without one it stays a failure.
  const failing = join(root, "failing-listing-clang");
  writeFileSync(failing, '#!/bin/sh\nprintf \'praesidium: a.cpp inc/b.txt\\n\' > "$2"\necho "a.cpp:1:1: error: x" >&2\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await analyzeProcess(failing, ["-MF", join(root, "failed.d")], root),
    { ok: false, exitCode: 1, diagnostics: true, dependencies: ["a.cpp", "inc/b.txt"] });
  const failingSilent = join(root, "failing-silent-clang");
  writeFileSync(failingSilent, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal((await analyzeProcess(failingSilent, ["-MF", join(root, "none.d")], root)).exitCode, 1);
});

test("the files a pass read are scanned under the collection limits and fail closed", async (t) => {
  const root = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "unit.cpp"), "int main() {}\n");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  const pragma = '#pragma clang diagnostic ignored "-Wformat-security"\n';
  for (const [file, text] of Object.entries({ "tracked.txt": pragma, "new.txt": pragma, "ignored.txt": pragma,
    "big.txt": "x".repeat(2 * 1024 * 1024 + 1), "nul.txt": "a\0b", "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]) })) {
    writeFileSync(join(root, file), text);
  }
  execFileSync("git", ["add", "unit.cpp", ".gitignore", "tracked.txt", "big.txt", "nul.txt", "latin.txt"], { cwd: root, stdio: "ignore" });
  const units = [{ file: "unit.cpp", standard: "c++20" }];
  const reading = dependencies => async (_command, args) => (args.includes("-MF")
    ? { ok: true, exitCode: 0, diagnostics: false, dependencies } : { ok: true, exitCode: 0 });
  const analyze = (dependencies, findings) => analyzeNative(root, [{ file: "unit.cpp" }], units, reading(dependencies),
    { host: {}, findings });
  // Tracked and nonignored new files are the repository's own; one Git ignores is not read.
  const findings = [];
  const outcomes = await analyze(["unit.cpp", "tracked.txt", "new.txt", "ignored.txt"], findings);
  assert.deepEqual(findings.map(item => item.file).sort(), ["new.txt", "tracked.txt"]);
  assert.equal(outcomes[0].status, "failed");
  await assert.rejects(analyze(["big.txt"]), /source size limit/);
  await assert.rejects(analyze(["nul.txt"]), /non-text source/);
  await assert.rejects(analyze(["latin.txt"]), TypeError);
  // A name that is not a file means the list was read wrongly.
  mkdirSync(join(root, "dir"));
  await assert.rejects(analyze(["dir"]), /dependency is not a file/);
  await assert.rejects(analyze(["gone.txt"]), /names no file/);
  mkdirSync(join(root, "many"));
  const many = Array.from({ length: 4097 }, (_, index) => `many/${index}.txt`);
  for (const file of many) writeFileSync(join(root, file), "x\n");
  await assert.rejects(analyze(many), /dependency count limit/);
  await analyze(many.slice(1));
  // 32 MiB in all, checked before any file is read; one file may be 2 MiB.
  mkdirSync(join(root, "large"));
  const large = Array.from({ length: 17 }, (_, index) => `large/${index}.txt`);
  for (const file of large) writeFileSync(join(root, file), "x".repeat(2 * 1024 * 1024));
  execFileSync("git", ["add", "large"], { cwd: root, stdio: "ignore" });
  await assert.rejects(analyze(large), /source size limit/);
  await analyze(large.slice(0, 1));
  // A listed name is resolved one component at a time, each asked of the system once per
  // scan, and Git is asked once per scan which files it tracks or would add: 300 headers and
  // 300 `.txt` files beside them at the end of a chain 1,000 directories deep (resolving each
  // name whole took about 7 s, the system reading it again at each component, and asking Git
  // once per 8,000 bytes of names, each walking the chain, about as long).
  if (process.platform !== "win32") {
    const chain = Array(1_000).fill("d").join("/");
    mkdirSync(join(root, chain), { recursive: true });
    const deep = Array.from({ length: 300 }, (_, index) => [`${chain}/h${index}.h`, `${chain}/y${index}.txt`]).flat();
    for (const file of deep) writeFileSync(join(root, file), "int x;\n");
    const started = performance.now();
    await analyze(deep);
    assert.ok(performance.now() - started < 1_500, `${performance.now() - started} ms`);
    // A name that climbs back with `..` lands on the directory the chain reached by name, so
    // nothing below it is asked again: 300 names climbing back at as many depths of the
    // chain took about 5 s when each landing asked again for every directory below it.
    const climbing = Array.from({ length: 300 }, (_, index) => {
      const depth = 3 * index + 1;
      return `${Array(depth).fill("d").join("/")}/../${Array(1_001 - depth).fill("d").join("/")}/y${index}.txt`;
    });
    const climbed = performance.now();
    await analyze(climbing);
    assert.ok(performance.now() - climbed < 1_500, `${performance.now() - climbed} ms`);
    // A repository path that holds a backslash fails the scan closed once a pass ran, read
    // or not: clang lists such a name with a slash there, so a listed name could stand for
    // another file or for none.
    mkdirSync(join(root, "a\\b"));
    writeFileSync(join(root, "a\\b/unread.txt"), "x\n");
    await assert.rejects(analyze(["unit.cpp"]), /backslash in a repository path/);
  }
});

test("a changed header needs a configured unit that can see it; Objective-C is reported, not required", async (t) => {
  const root = fixture(t);
  const units = [{ file: "src/codec.cpp", standard: "c++20", includes: ["include/../core"] }, { file: "app/main.mm", standard: "c++20" }];
  assert.equal(headerUnit("core/bytes.hpp", units), units[0]);
  assert.equal(headerUnit("src/detail/ring.inl", units), units[0]);
  assert.equal(headerUnit("app/view.h", units), null);
  const sources = ["src/codec.cpp", "app/main.mm", "app/view.h", "app/capture.mm"].map(file => ({ file }));
  const unseen = await analyzeNative(root, sources, units, async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["app/view.h"]) });
  assert.deepEqual(unseen, [{ rule: "native.configuration-required", status: "error" }]);
  const scanned = await scanRepository({ root, collect: () => [{ file: "app/capture.mm", source: "void f() {}" }],
    changedPaths: ["app/capture.mm"] });
  assert.equal(scanned.status, "passed");
  assert.deepEqual(scanned.coverage.nativeNotAnalyzed, ["app/capture.mm"]);
  assert.equal(scanned.coverage.nativeUnits, 0);
});

test("suppression and lexing hold on the preprocessor's view: digraphs, splices, comments and C rules", () => {
  const rejected = {
    "native.analysis-suppression": [
      ["a.cpp", '%:pragma clang diagnostic ignored "-Wformat-security"'],
      ["a.cpp", '#pragma /*\n*/ clang diagnostic ignored "-Wformat-security"'],
      ["a.cpp", '#pragma \\\nclang diagnostic ignored "-Wformat-security"'],
      ["a.cpp", "int f(int* p) { __attribute__((suppress)) return *p; }"],
      ["a.cpp", "int f(int* p) { [ [clang::suppress] ] return *p; }"],
      ["a.cpp", "int f(int* p) { [[clang::\nsuppress]] return *p; }"],
      ["a.cpp", "int f(int* p) { <:<:clang::suppress:>:> return *p; }"],
      // Every spelling the rule claims, each guarded on its own.
      ["a.cpp", '# 1 "x" 3'],
      ["a.cpp", '# 1 "x" 1 3 4'],
      ["a.h", "#pragma GCC system_header"],
      ["a.cpp", '#pragma clang diagnostic warning "-Wformat"'],
      ["a.cpp", '_Pragma("clang diagnostic ignored \\"-Wformat\\"")'],
      ["a.cpp", "#ifdef __clang_analyzer__\n#endif"],
      ["a.cpp", "int f(int* p) { [[clang::__suppress__]] return *p; }"],
      ["a.cpp", "int f(int* p) { __attribute__((__suppress__)) return *p; }"],
      // Clang takes \f and \v as directive whitespace, and C++14/C23 digit separators.
      ["a.cpp", '#\f1 "x" 3'],
      ["a.cpp", '# 1\v"x" 3'],
      ["a.cpp", '# 1 "x"\f3'],
      ["a.cpp", '\f# 1 "x" 3'],
      ["a.cpp", "# 1'0 \"x\" 3"],
      ["a.c", "# 1'0 \"x\" 3"],
      // Clang macro-expands a linemarker's file name and flags, so every linemarker is a switch.
      ["a.c", '#define SYS 3\n# 1 "deref.c" SYS'],
      ["a.c", '#define FN "deref.c" 3\n# 1 FN'],
      ["a.cpp", '# 1 "x"'],
      // Microsoft's system_header, honored on *-windows-msvc targets.
      ["a.h", "#pragma system_header"],
      ["a.cpp", '#pragma\fclang diagnostic ignored "-Wformat"'],
      ["a.cpp", '#\vpragma clang\vdiagnostic\fignored "-Wformat"'],
      // Microsoft's pragma operator, whose tokens clang macro-expands, in any position.
      ["a.c", 'int f(void) { __pragma(clang diagnostic ignored "-Wdeprecated-declarations") return 0; }'],
      ["a.cpp", "#define PRAGMA(x) __pragma(x)"],
      // analyzer_noreturn ends every analyzed path at a call that returns.
      ["a.c", "static void trace(void) __attribute__((analyzer_noreturn));"],
      ["a.c", "#define ANR __analyzer_noreturn__\nstatic void trace(void) __attribute__((ANR));"],
      // The GNU keyword without trailing underscores, and the name itself.
      ["a.c", "int f(int* p) { __attribute((suppress)) return *p; }"],
      ["a.cpp", "#undef suppress"],
      // However far `suppress` stands from its opener, also behind a directive's `]`.
      ["a.cpp", "int f(int* p) { [[/*" + "x".repeat(300) + "*/clang::suppress]] return *p; }"],
      ["a.c", "int f(int* p) { __attribute__((/*" + "x".repeat(300) + "*/suppress)) return *p; }"],
      ["a.cpp", "int f(int* p) { [[assume(" + "1+".repeat(200) + "1), clang::suppress]] return *p; }"],
      ["a.cpp", "int f(int* p) { [[\n#define Y ]\nclang::suppress]] return *p; }"],
      // At any depth: a function-like macro can move the word into parentheses.
      ["a.cpp", "#define A(x) clang::x\nint f(int* p) { [[A(suppress)]] return *p; }"],
      ["a.c", "#define ATTR __attribute__((\nint f(void) ATTR suppress));"],
      // Directive lines between the two brackets of an opener leave it an opener.
      ["a.cpp", "int f(int* p) {\n  [\n#if 1\n#endif\n  [clang::suppress]] return *p;\n}"],
      ["a.cpp", "int f(int* p) { [\n#\n[clang::suppress]] return *p; }"],
      ["a.c", "int f(int* p) {\n  __attribute__(\n#if 1\n#endif\n  (suppress)) return *p;\n}"],
      ["a.c", "int f(int* p) { __attribute__\n#define Z\n((suppress)) return *p; }"],
      ["a.c", "int f(int* p) { __attribute__\n#if 1\n(\n#endif\n(suppress)) return *p; }"],
      // The gsl scope is the one the analyzer ignores; any other scope, none, or `gsl` made
      // a macro is the analyzer's attribute.
      ["a.cpp", "int f(int* p) { [[gsl::suppress(\"x\"), clang::suppress]] return *p; }"],
      ["a.cpp", "int f(int* p) { [[suppress]] return *p; }"],
      ["a.cpp", "#define gsl clang\nint f(int* p) { [[gsl::suppress]] return *p; }"],
      // A directive between `gsl` and `::suppress` can change what clang reads there: a
      // skipped group around `gsl`, or an included `, clang`.
      ["a.cpp", "int f(int* p) {\n  [[clang\n#if 0\n  gsl\n#endif\n  ::suppress]] return *p;\n}"],
      ["a.cpp", "int f(int* p) { [[gsl\n#include \"comma_clang.inc\"\n::suppress]] return *p; }"],
      // A header job compiles the header as the main file, which a product build never does.
      ["a.h", "#if __INCLUDE_LEVEL__ > 0\nint g(void);\n#endif"],
      ["a.hpp", "static_assert(sizeof(__BASE_FILE__) > 0);"],
      // A header-name opener in `LESS(<)` stays visible to the _Pragma rule.
      ["a.c", '#define LESS(op) (1 op 2)\n#if LESS(<) _Pragma("clang diagnostic ignored \\"-Wformat\\"") || LESS(>)\n#endif'],
    ],
    // A macro can make clang read `<...>` in #if/#elif as a header name, where the
    // masker opened a comment or literal that hides code after the `>`.
    "native.ambiguous-header-name": [
      ["a.cpp", "#define HAS_HEADER __has_include\n#if HAS_HEADER(<compat/*.h>)\n#endif\nint r(const char* c) { return system(c); }\n/* end */"],
      ["a.c", "#define LP (\n#if __has_include LP <compat/*.h>)\n#endif\n/* end */"],
      ["a.h", '#define H __has_include\n%:elif H(<compat//x.h>) _Pragma("clang diagnostic ignored \\"-Wformat\\"")'],
      ["a.c", '#define H __has_include\n#if H(<compat"x.h>) || 1\n#endif'],
      // #embed and these pragmas always read a header name.
      ["a.c", "#pragma GCC dependency <compat/*.h>\nint r(const char* c) { return system(c); }\n/* end */"],
      ["a.c", "#pragma include_alias(<compat/*.h>, <c.h>)\n/* end */"],
      ["a.c", "#embed <compat/*.h>\n/* end */"],
      // A splice right after `<`, inside the name or before `>` does not end it.
      ["a.c", "#define H __has_include\n#if H(<\\\ncompat/*.h>)\n#endif\n/* end */"],
      ["a.c", "#define H __has_include\n#if H(<compat/\\\n*.h>)\n#endif\n/* end */"],
      ["a.c", "#define H __has_include\n#if H(<compat/*.h\\\n>)\n#endif\n/* end */"],
      // C17's literal at a digit separator is let through only before an inert rest of the line.
      ["a.c", "#define H __has_include\n#if H(<x 1'0>) || \"a\" 1\n#endif"],
      ["a.c", "#define H __has_include\n#if H(<x a'0>) || 1\n#endif"],
      ["a.c", "#define H __has_include\n#if H(<x 1'0>) || 1 /*\n#endif\n*/"],
      ["a.c", "#define H __has_include\n#if H(<x 1'0>) || 1 \\\n#endif\n"],
      // A second `'` closes the rest's own literal, after which `/*` opens a comment.
      ["a.c", "#define H __has_include\n#if H(<x 1'0>) || 2'0'/*\n#endif\n*/"],
      // A `<` in the rest can open another header name, which reads a comment opener or a
      // quote as plain text: after `</*>`, `<a'b/*>` or `<a//b>` a comment stays open for
      // clang. The C23 reading is in a comment there, so only the C17 reading can tell.
      ["a.c", "#if 0\n1'0 /*\n#endif\n#define H __has_include\n#if H(<a 1'0>) || H(</*>) /*/\n// \\\n*/ || _Pragma(\"clang diagnostic ignored \\\"-Wdeprecated-declarations\\\"\") 1\n#endif"],
      ["a.c", "#if 0\n1'0 /*\n#endif\n#define H __has_include\n#if H(<a 1'0>) || H(<a'b/*>) /*/\n#endif\n#if 0\n*/\n#endif"],
      ["a.c", "#if 0\n1'0 /*\n#endif\n#define H __has_include\n#if H(<a 1'0>) || H(<a//b>) /*\n#endif\n#if 0\n*/\n#endif"],
      // The C23 reading can be inside a comment there (opened after `1'0`), so the C17
      // reading must stand on its own: no word the suppression rule rejects, and no
      // exemption outside #if, where a pragma's own tokens may matter.
      ["a.c", "#if 0\n1'0 /*\n#endif\n#define H __has_include\n#if H(<x 1'0>) || __pragma(GCC system_header) 1\n#endif\n#if 0\n*/\n#endif"],
      ["a.c", "#define H __has_include\n#if H(<x 1'0>) || __INCLUDE_LEVEL__ > 0\n#endif"],
      ["a.c", "#if 0\n1'0 /*\n#endif\n#pragma clang attribute push(__attribute__((annotate(a < 1'0 > 2), suppress)), apply_to = function)\n#if 0\n*/\n#endif"],
      // A header name skips escaped characters, so `<a\> /* >` ends at the second `>`, and a
      // splice may have blanks before its line break.
      ["a.c", "#define H __has_include\n#if H(<a\\> /* >) || 1\n#endif\n_Pragma(\"GCC system_header\")\n// */"],
      ["a.c", "#define H __has_include\n#if H(<a \\ \n/* >) || 1\n#endif\n// */"],
      // The literal after a `<` let through as a C23 comparison may close on the line, and
      // the code after it may hold a header name of its own (`F(...)` takes any tokens).
      ["a.c", "#define H __has_include\n#define F(...) 1\n#if F(0 < 1'>') || H(<x/*>) /*/\nint skipped;\n// */ || _Pragma(\"clang diagnostic ignored \\\"-Wdeprecated-declarations\\\"\") 1\n#endif"],
      ["a.c", "#define H __has_include\n#define $1 1 +\n#if 0 < $1'>' || H(<x/*>) /*/\nint skipped;\n// */ || _Pragma(\"clang diagnostic ignored \\\"-Wdeprecated-declarations\\\"\") 1\n#endif"],
      // Only a `'` right after a pp-number may be a digit separator; `$1` and `é1` are names.
      ["a.c", "#define H __has_include\n#if H(<$1'>) || 1 // n\n#endif"],
      ["a.c", "#define H __has_include\n#if H(<\u00e91'>) || 1 // n\n#endif"],
      ["a.c", "#define H __has_include\n#if H(<1$1'>) || 1 // n\n#endif"],
      // The rest's tokens hold no `'`: `'x /* '` would be a literal there, and the `/*/` after
      // it would open a comment that the masker's readings close.
      ["a.c", "#define H __has_include\n#define F(...) 1\n#if H(<1'0>) || F(2'x /* ' ) /*/\n// \\\n*/ _Pragma(\"clang diagnostic ignored \\\"-Wdeprecated-declarations\\\"\")\n#endif"],
    ],
    "native.command-execution": [
      ["a.cpp", "/* lead */ #include <x/*y>\nreturn system(cmd);\n/* end */"],
      ["a.cpp", "%:include <x/*y>\nreturn system(cmd);\n/* end */"],
      ["a.cpp", "#\\\ninclude <x/*y>\nreturn system(cmd);\n/* end */"],
      // C has no raw strings, no import and (before C23) no digit separators.
      ["a.c", '#define R\nR"(x"; int r = system(c); //)";'],
      ["a.c", "S(1'0'); int r = system(c);"],
      ["a.c", "import <a, system(c), a>0);"],
      ["a.h", "S(1'0'); int r = system(c);"],
      // A splice between `*` and `/` still ends the comment.
      ["a.mm", "/* note *\\\n/ return system(c);\n/* end */"],
    ],
    "native.unbounded-scan": [
      ["a.cpp", 'std::sscanf(in, "%1$s", b);'],
      ["a.cpp", 'std::sscanf(in, "%\\x73", b);'],
      ["a.cpp", '#define FMT "%s"\nstd::sscanf(in, FMT, b);'],
      // Line splices go before escapes (phase 2), so `%\` + newline + `s` is `%s`.
      ["a.cpp", 'std::sscanf(in, "%\\\ns", b);'],
      ["a.cpp", 'std::sscanf(in, "%\\\r\ns", b);'],
      ["a.cpp", 'std::sscanf(in, "%\\ \t\ns", b);'],
      ["a.cpp", 'std::sscanf(in, "%\\\n\rs", b);'],
      ["a.c", 'sscanf(in, "%\\\\\nx73", b);'],
      // C has no raw strings: `R` is a name there, so the format cannot be checked. A
      // header may be compiled as C, so this holds for a raw-string format in a header.
      ["a.c", '#define R\nsscanf(in, R"%\\x73", b);'],
      ["a.h", 'inline int r(const char* in, char (&b)[16]) { return std::sscanf(in, R"(%15s)", b); }'],
    ],
  };
  for (const [rule, cases] of Object.entries(rejected)) {
    for (const [file, code] of cases) assert.ok(sourceFindings(file, code).some(item => item.rule === rule), `${rule}: ${code}`);
  }
  for (const code of ["[[maybe_unused]] bool suppress = true; void suppress_all();", "std::vector<::Foo> v; a<:0:> = 1;",
    'std::scanf("%ms", &p);', "#define\fstrcpy(d, s) x", "int __pragmatic(void); int analyzer_noreturn_count;",
    "#define LOG_IF(msg, suppress) do { if (!(suppress)) log(msg); } while (0)", 'std::sscanf(in, R"(%\\\ns)", b);',
    "#if __has_include(<a/*b>) && A<B && C>D\n#endif", '#if X\n#elif __has_include("a.h") || X < 3 && Y > 2 // c++ -> d\n#endif',
    "#if A < 1'000 && B > 2 /* x */\n#endif", "#define H __has_include\n#if H(<a:>)\n#endif",
    "#pragma include_alias(<a.h>, <b.h>)\n#embed <data.bin> limit(8)\n#pragma omp parallel for if(n < 100 && m > 2)",
    "[[nodiscard]] int f(); int g(int suppress); int x = a[b[suppress]]; int y = [[deprecated]] suppress;",
    "int f(int* p) { [[gsl::suppress(\"type.1\")]] [[ gsl :: suppress(\"r.11\") ]] return *p; }",
    "int x = a[\n#if 1\n#endif\nsuppress]; int y = f(\n#if 1\n#endif\n(suppress));"]) {
    assert.deepEqual(sourceFindings("a.cpp", code), [], code);
  }
  // C17 reads a C23 digit separator as a character literal; before an inert rest of the
  // line it hides nothing a header-name reading would compile: division, another digit
  // separator, a comment that closes (a quote in it closes the masker's literal there).
  for (const file of ["a.c", "a.h"]) {
    for (const code of ["#if A < 1'000 && B > 2\n#endif", "#if A < 0x1F'00 && B > MIN_B // note\n#endif",
      "#if A < 1'000 && B > 2 /* x */\n#endif", "#if A < 1'000 && B > N / 2\n#endif", "#if A < 1'000 && B > 2'000\n#endif",
      "#if A < 1'000 && B > 2'000 // n < m\n#endif", "#define H __has_include\n#if H(<x 1'0>) /* ' */ || 1\n#endif",
      // A later `<` with no `>` after it is a comparison in every reading, so a comment may follow.
      "#if A < 1'000 && B > 2 && C < 3 // legacy range\n#endif", "#if A < 1'000 && B > 2 && C < 3 /* legacy */\n#endif",
      "#if PAGE < 8'192 && ALIGN > 8 && ALIGN < 64 // fits in one page\n#endif",
      "#if SIZE < 4'096 && ALIGN > 8 /* bytes */ && ALIGN <= 64\n#endif", "#if A < 1'000 && B > 2'000 && C < 4\n#endif",
      "#if A < 1'000 && B > 2'000 // the \"limit\"\n#endif", "#if A < 1'000 && B > 2 /* a < b > c */\n#endif"]) {
      assert.deepEqual(sourceFindings(file, code), [], `${file}: ${code}`);
    }
  }
  // A directive after a comment or splice that the logical view joins into its line
  // reports the line of its `#`.
  assert.equal(sourceFindings("a.cpp", '/* a\n * b\n */ #pragma clang diagnostic ignored "-Wall"\n')[0].line, 3);
  assert.equal(sourceFindings("a.h", "int a;\n\\\n#pragma GCC system_header\n")[0].line, 3);
  assert.equal(sourceFindings("a.cpp", "#define H __has_include\n/* a\n */ #if H(<a/*b>)\n#endif\n")[0].line, 3);
  const started = performance.now();
  sourceFindings("a.cpp", "int a" + "[[x".repeat(160_000));
  sourceFindings("a.h", "%:".repeat(500_000));
  sourceFindings("a.cpp", "suppress ".repeat(200_000));
  sourceFindings("a.cpp", "#if <\n".repeat(350_000));
  sourceFindings("a.cpp", "#if " + "<".repeat(1_000_000) + " /* x */ >");
  sourceFindings("a.cpp", "system ) ".repeat(230_000));
  sourceFindings("a.cpp", "return ::system(x);".repeat(110_000));
  sourceFindings("a.cpp", "[[" + " ".repeat(1_000_000) + "suppress");
  sourceFindings("a.cpp", "__attribute__((".repeat(100_000) + "suppress");
  sourceFindings("a.cpp", "[[x]] suppress ".repeat(100_000));
  sourceFindings("a.cpp", "#define A [[\n".repeat(150_000) + "suppress");
  sourceFindings("a.c", "#if A < 1'0 > 2\n".repeat(100_000));
  sourceFindings("a.c", "#if A < 1'0 > " + "/*".repeat(500_000));
  assert.ok(performance.now() - started < 20_000);
});

test("C/C++ lexing reads splices, pp-numbers, UCNs, header names and lexing sets as clang does", () => {
  // `#if 0` skips the line without diagnostics, so only the lexer decides what follows it.
  const skipped = (line) => `#if 0\n${line}\n#endif\nint r = system(c); // */`;
  const rejected = {
    "native.command-execution": [
      // An escaped backslash before a splice: the literal is "a\b", not unterminated.
      ["a.c", 'const char* p = "a\\\\\nb"; int r = system(c); //"'],
      ["a.cpp", 'const char* p = "a\\\\\nb"; int r = system(c); //"'],
      // A splice may have blanks before its line break, and LF CR is one line break.
      ["a.mm", 'const char* p = "a\\ \t\n"; int r = system(c); //"'],
      ["a.cpp", 'const char* p = "abc\\\n\r"; int r = system(c); //"'],
      // A pp-number goes on across splices and through non-ASCII characters and UCNs.
      ["a.cpp", "S(1'\\\n0); int r = system(c);"],
      ["a.cpp", "S(1\\\n'0); int r = system(c);"],
      ["a.c", "S(1'\\\n0); int r = system(c);"],
      ["a.cpp", "S(1\u00e9'0); int r = system(c);"],
      ["a.cpp", "S(1\\u00e9'0); int r = system(c);"],
      ["a.cpp", "S(1\\u{e9}'0); int r = system(c);"],
      ["a.cpp", "S(1\\N{LATIN SMALL LETTER E WITH ACUTE}'0); int r = system(c);"],
      // ... but not through Unicode whitespace, a sign after a separator, `p+` in a C++
      // decimal, `\U{...}`, or a UCN below U+00A0.
      ["a.cpp", skipped("1\u00a0'a/*")],
      ["a.cpp", skipped("1'e+'a/*")],
      ["a.cpp", skipped("1p+'a/*")],
      ["a.cpp", skipped("1\\U{e9}'a/*")],
      ["a.cpp", skipped("1\\u0080'a/*")],
      // An identifier goes on through UCNs; `\N{...}` is one token up to its `}`.
      ["a.cpp", skipped("x\\u{e9}0'a/*")],
      ["a.cpp", skipped("\\u{e9}0'a/*")],
      ["a.cpp", skipped("\\N{a/*b}")],
      // A name of other characters is a token of its own, and a UCN whose value would not
      // fit in 32 bits is a lone backslash: neither continues the number before it.
      ["a.cpp", skipped("1\\N{latin small letter e with acute}'a/*")],
      ["a.cpp", skipped("1\\u{10000000e9}'a/*")],
      // Unicode whitespace separates tokens.
      ["a.mm", "S(1\u00a00'0); int r = system(c);"],
      ["a.mm", "S(1\\u00a00'0); int r = system(c);"],
      ["a.mm", "#\u00a0include <x/*y>\nint r = system(c);\n/* */"],
      // A raw string's prefix may be split from its quote by a splice.
      ["a.cpp", 'auto s = R\\\n"( " )"; int r = system(c); auto t = "";'],
      // C23 has digit separators, Objective-C is C, and a header may be C++.
      ["a.c", "int x = 1'000; int r = system(c); char q = 'x';"],
      ["a.m", '#define R\nR"(x"; int r = system(c); //)";'],
      ["a.hpp", 'R"( " )"; int r = system(c); auto t = "";'],
      // A splice inside a literal does not end the line: `#include` after it is the
      // stringizing operator, not a directive (clang -E keeps the call).
      ["a.cpp", '#define LOG(include, c) "a\\\nb"#include << system(c)\n'],
      ["a.c", '#define LOG(include, c) "a\\\r\nb"%:include << system(c)\n'],
      ["a.cpp", '#define LOG(import, c) "a\\\nb" import << system(c)\n'],
      // A UCN naming Unicode whitespace ends a number, also split by a splice.
      ["a.cpp", skipped("1\\N{NO-BREAK SPACE}'a/*")],
      ["a.cpp", skipped("1\\N{IDEOGRAPHIC\\\n SPACE}'a/*")],
      ["a.mm", "#define Z 1\\N{EM SPACE}'a/*\nint r = system(c);\n// */"],
      // A header name has escapes: `<a\>/*b>` is one name.
      ["a.cpp", "#if __has_include(<a\\>/*b>)\n#endif\nint r = system(c);\n// */"],
      ["a.cpp", "#include <a\\>/*b>\nint r = system(c);\n// */"],
      // The text of `#error`, `#warning` and `#pragma mark` is raw to the logical line end.
      ["a.mm", "#warning see /* notes\nint r = system(c);\n// */"],
      ["a.m", "#error see /* notes\nint r = system(c);\n// */"],
      ["a.c", "#pragma mark - helpers /* notes\nint r = system(c);\n// */"],
      ["a.cpp", "%:pragma /* */ ma\\\nrk x\\\n /* notes\nint r = system(c);\n// */"],
      ["a.cpp", '#warn\\\ning R"x( notes\nint r = system(c);\n// )x"'],
      // Unicode whitespace, raw or as a UCN, reads as a space before a call or a header name.
      ["a.mm", "int r = system\\u00a0(c);"],
      ["a.mm", "int r = system\\U000000a0(c);"],
      ["a.mm", "int r = system\\N{NO-BREAK SPACE}(c);"],
      ["a.mm", "int r = system\\u\\\n3000(c);"],
      ["a.mm", "int r = system\u0085(c);"],
      ["a.mm", "int r = system᠎(c);"],
      ["a.cpp", "#if __has_include\\u00a0(<x/*y>)\n#endif\nint r = system(c);\n/* */"],
    ],
    "native.identifier-splice": [["a.mm", "sys\\ \ntem(c);"], ["a.c", '# 1\\\n0 "x" 3\n']],
    // Clang ends a pp-number at an invalid name in a skipped group (`\N{NOPE}`, the
    // abbreviation `\N{NBSP}`); the lexer cannot tell such a name from a valid one, so any
    // named UCN in code is rejected, also split by splices.
    "native.named-ucn": [["a.cpp", skipped("1\\N{NOPE}'a/*")], ["a.cpp", skipped("1\\N{NBSP}'a/*")],
      ["a.c", skipped("1\\N{NOPE}'a/*")], ["a.mm", "int caf\\N{LATIN SMALL LETTER E WITH ACUTE} = 1;"],
      ["a.cpp", "int x\\\\\nN{DIGIT ONE} = 1;"], ["a.cpp", "int x\\N\\ \n{DIGIT ONE} = 1;"]],
    // ISO C before C23 replaces trigraphs first: `??/` joins lines or escapes a quote, `??'`
    // is not a quote, and `??=` starts a directive. A header may be compiled as C17.
    "native.trigraph": [["a.m", "str??/\ncpy(d, s);"], ["a.c", 'const char* p = "??/"; /* "\nint r = system(c);\n// */'],
      ["a.c", "int x = a ??' b; strcpy(d, s);"], ["a.c", "char q = '??''; strcpy(d, s);"], ["a.c", "/* a *??/\n/ strcpy(d, s);"],
      ["a.m", "??=pragma GCC system_header"], ["a.hpp", "x = 1;\n  ??=include <a/*b>\nint r = system(c);"]],
    "native.unbounded-copy": [
      ["a.cpp", "#include \\\n<x/*y>\nstrcpy(a, b);\n/* */"],
      ["a.cpp", "import <x/*y>;\nstrcpy(a, b);\n/* */"],
      ["a.cpp", "export import <x/*y>;\nstrcpy(a, b);\n/* */"],
    ],
    "native.analysis-suppression": [
      ["a.cpp", 'auto n = "a\\\\\nb"; auto o = "/*";\n#pragma clang diagnostic ignored "-Wformat-security"\n// */'],
      // A splice inside a digraph, or inside a linemarker's file name, is still one line.
      ["a.cpp", '%\\\n:pragma clang diagnostic ignored "-Wformat-security"'],
      ["a.c", "%\\\r\n:pragma GCC system_header\r\n"],
      ["a.cpp", "int f(int* p) { <\\\n:<:clang::suppress:>:> return *p; }"],
      ["a.c", '# 1 "x\\\n" 3\nint y;\n'],
      ["a.c", '# 1 "x\\\r\n" 3\r\nint y;\r\n'],
      ["a.hpp", '# 1 "lib\\\nx.h" 3\n'],
      ["a.cpp", '# 1 "\\\r\nx.h" 3\r\n'],
      // `\v`, `\f` and Unicode whitespace separate a directive's tokens.
      ["a.c", '#pragma\vclang\fdiagnostic\vignored "-Wformat-security"\n'],
      ["a.c", '#\fpragma clang diagnostic ignored "-Wformat-security"\n'],
      ["a.c", "# pragma GCC system_header\n"],
      ["a.c", "#pragma\\u00a0GCC system_header\n"],
    ],
  };
  for (const [rule, cases] of Object.entries(rejected)) {
    for (const [file, code] of cases) assert.ok(sourceFindings(file, code).some(item => item.rule === rule), `${rule}: ${file}: ${code}`);
  }
  assert.deepEqual(sourceFindings("a.cpp", "<:<:nodiscard:>:> int f(); bool suppress;"), []);
  // A named UCN in a literal or a comment, and one of Unicode whitespace (layout in the
  // logical view, as for clang), are not code; nor are the trigraphs that move no boundary,
  // or `??=` in a literal or a comment.
  for (const [file, code] of [["a.cpp", 'auto s = u8"\\N{NOPE}"; // \\N{NOPE}'], ["a.cpp", "int x =\\N{NO-BREAK SPACE}1;"],
    ["a.c", "/* Data select (??) */ int x = a ??! b ??- c;"], ["a.c", 'const char* t = "??="; // a ??= b'],
    ["a.h", "T_COALESCE = 400, /* \"'??'\" */"], ["a.c", 'const char* q = "why??\'";'],
    // C++17 and later, the only C++ standards Praesidium accepts, have no trigraphs.
    ["a.cpp", "// An unknown date is shown as ??/??/???? until the record loads.\nconst char* p = \"a??/\";"],
    ["a.mm", "unsigned int creator = '????';"], ["a.cc", "char c = '??''; ??=define X"]]) {
    assert.deepEqual(sourceFindings(file, code), [], code);
  }
  // Only the logical view blanks a splice's line break inside a literal, and every view
  // keeps the source's length, even after a backslash at the end of input.
  assert.equal(maskNativeCode('"a\\\nb"'), '"  \n "');
  assert.equal(maskNativeCode('"a\\\nb"', { logical: true }), '"    "');
  assert.equal(maskNativeCode('"a\\').length, 3);
  // A splice read inside a number is marked like any other.
  assert.equal(maskNativeCode("x = 1'\\\n0;", { logical: true }), "x = 1'  0;");
  assert.equal(maskNativeCode("x = 1\\\n0;", { logical: true }), "x = 1\u0001\u00010;");
  // Only the logical view writes layout other than a space or a tab as spaces.
  const layout = "a b\\u00a0c\vd\te";
  assert.equal(maskNativeCode(layout, { logical: true }), "a b      c d\te");
  assert.equal(maskNativeCode(layout), layout);
  // A message directive's text is masked to the end of its logical line.
  assert.equal(maskNativeCode("#error it's /*\\\nx\ny", { logical: true }), "#error           \ny");
});

test("a changed header is analyzed with a unit of its own language; Objective-C headers are reported", async (t) => {
  const root = fixture(t);
  const units = [{ file: "src/a.c", standard: "c17", includes: ["include"] }, { file: "src/b.cpp", standard: "c++20", includes: ["include"] },
    { file: "mac/view.mm", standard: "c++20" }];
  assert.equal(headerUnit("include/x.hpp", units, headerLanguage("include/x.hpp", "#include <vector>")), units[1]);
  assert.equal(headerUnit("include/c.h", units, headerLanguage("include/c.h", "int f(void);")), units[0]);
  assert.equal(headerUnit("include/n.h", units, headerLanguage("include/n.h", "namespace n { int f(); }")), units[1]);
  assert.equal(headerLanguage("mac/kit.hpp", "#import <ScreenCaptureKit/ScreenCaptureKit.h>"), "objective-c");
  assert.equal(headerUnit("mac/kit.hpp", units, "objective-c"), units[2]);
  const sources = [{ file: "src/b.cpp" }, { file: "app/capture.hpp", source: "#import <Foundation/Foundation.h>\n@interface A\n@end\n" }];
  const outcome = await analyzeNative(root, sources, [units[1]], async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["app/capture.hpp"]) });
  assert.deepEqual(outcome, []);
  assert.deepEqual(unanalyzedPlatformUnits(sources, [units[1]], new Set(["app/capture.hpp"])), ["app/capture.hpp"]);
  // The preference holds whatever the configuration order: C for a plain .h, Objective-C
  // only from an Objective-C unit.
  const reordered = [units[1], units[0]];
  assert.equal(headerUnit("include/c.h", reordered, headerLanguage("include/c.h", "int f(void);")), units[0]);
  const objc = [{ file: "src/b.cpp", standard: "c++20", includes: ["."] }, units[2]];
  assert.equal(headerUnit("mac/kit.hpp", objc, "objective-c"), units[2]);
  assert.equal(headerUnit("mac/kit.hpp", [objc[0]], "objective-c"), null);
  // Comments never choose the language (a comment naming @interface once skipped analysis).
  assert.equal(headerLanguage("include/c.h", "// the namespace and class live in the C++ wrapper\nint f(void);\n"), null);
  assert.equal(headerLanguage("include/c.hpp", "// mirrors the @interface in capture.mm\nint f();\n"), "c++");
  // Objective-C only when its markers are compiled unconditionally (an include guard aside).
  assert.equal(headerLanguage("x.hpp", "#ifdef __OBJC__\n@class NSData;\n#endif\nint f();\n"), "c++");
  assert.equal(headerLanguage("x.h", "#if 0\n@class X;\n#else\ntypedef struct X X;\n#endif\n"), null);
  assert.equal(headerLanguage("x.h", "#ifndef X_H\n#define X_H\n#import <Foundation/Foundation.h>\n#endif\n"), "objective-c");
  // The other spelling of a whole-file guard; a condition on more than the guard stays one.
  assert.equal(headerLanguage("x.h", "#if !defined(X_H)\n#define X_H\n#import <AppKit/AppKit.h>\n@interface V\n@end\n#endif\n"), "objective-c");
  assert.equal(headerLanguage("x.h", "#if !defined X_H\n#define X_H\n@class V;\n#endif\n"), "objective-c");
  assert.equal(headerLanguage("x.hpp", "#if !defined(X_H) || defined(Y)\n#define X_H\n@class V;\n#endif\n"), "c++");
  // A guard-shaped group with code outside it is a condition, which one compiler may skip.
  assert.equal(headerLanguage("x.hpp", "inline int f();\n#ifndef _MSC_VER\n#define _MSC_VER\n@class X;\n#endif\n"), "c++");
  assert.equal(headerLanguage("x.hpp", "#ifndef _MSC_VER\n#define _MSC_VER 1900\n@class NSData;\n#endif\ninline int f();\n"), "c++");
  // C23 spellings are not C++ (a C-only repository cannot configure a C++ unit).
  const cOnly = [{ file: "src/a.c", standard: "c23" }];
  assert.equal(headerLanguage("src/x.h", "[[gnu::always_inline]] static inline int f(void) { return 0; }"), null);
  assert.equal(headerLanguage("src/x.h", "static inline int f(int *p) { return p == nullptr; }"), "c23-or-c++");
  assert.equal(headerUnit("src/x.h", cOnly, "c23-or-c++"), cOnly[0]);
  const c11First = [{ file: "src/old.c", standard: "c11" }, cOnly[0]];
  assert.equal(headerUnit("src/x.h", c11First, "c23-or-c++"), cOnly[0]);
  assert.equal(headerUnit("src/x.h", c11First, null), c11First[0]);
  assert.equal(headerUnit("include/n.h", units, "c23-or-c++"), units[1]);
  // A .h with C++ spellings and no C++ unit is compiled as C, which rejects real C++.
  assert.equal(headerUnit("src/x.h", cOnly, headerLanguage("src/x.h", "struct ev { int class; };")), cOnly[0]);
  assert.equal(headerUnit("src/x.hpp", cOnly, "c++"), null);
  // A header that tests __cplusplus is compiled in both languages.
  const dual = "#ifdef __cplusplus\nextern \"C\" {\n#endif\nint f(void);\n#ifdef __cplusplus\n}\nnamespace n { int g(); }\n#endif\n";
  assert.equal(headerLanguage("include/d.h", dual), "c-and-c++");
  assert.deepEqual(headerUnits("include/d.h", units, "c-and-c++"), [units[0], units[1]]);
  assert.equal(headerLanguage("include/d.h", dual.replace("int f(void);", "namespace m {}")), "c++");
  // A marker-free .h that only C++ files include prefers a C++ unit.
  assert.equal(headerUnit("include/v.h", units, null, { c: false, cxx: true }), units[1]);
  assert.equal(headerUnit("include/v.h", units, null, { c: true, cxx: true }), units[0]);
  // A C header that tests __cplusplus only for C++ linkage gets a C++ unit too only when a
  // C++ file includes it; C++ code under __cplusplus, or another test, makes it both.
  const linkage = "#ifndef B_H\n#define B_H\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nchar *b(void);\n"
    + "#ifdef __cplusplus\n}  // extern \"C\"\n#endif\n#endif\n";
  assert.equal(headerLanguage("include/b.h", linkage), "c-linkage");
  assert.deepEqual(headerUnits("include/b.h", units, "c-linkage"), [units[0]]);
  assert.deepEqual(headerUnits("include/b.h", units, "c-linkage", { c: true, cxx: false }), [units[0]]);
  assert.deepEqual(headerUnits("include/b.h", units, "c-linkage", { c: true, cxx: true }), [units[0], units[1]]);
  assert.deepEqual(headerUnits("include/b.h", units, "c-linkage", { c: false, cxx: true }), [units[1]]);
  assert.equal(headerLanguage("include/b.h", linkage.replace("}  //", "inline int g() { return 1; }\n}  //")), "c-and-c++");
  assert.equal(headerLanguage("include/b.h", linkage.replace("char *b(void);", "#if defined(__cplusplus) || defined(B)\nint g(void);\n#endif")),
    "c-and-c++");
  assert.equal(headerLanguage("include/b.h", linkage.replace("char *b(void);", "#if X\n#elif defined(__cplusplus)\nint g(void);\n#endif")),
    "c-and-c++");
  // So do a use in a definition or in code, and a directive in a group only one language
  // takes that can give the shared body another meaning in the other language: a definition
  // other than linkage boilerplate, an #undef or an include.
  const isCxx = "#ifndef A_H\n#define A_H\n#define IS_CXX __cplusplus\n#if IS_CXX\nstatic inline int g(int *p) { (void)p; return *(int *)0; }\n#endif\n#endif\n";
  assert.equal(headerLanguage("src/a.h", isCxx), "c-and-c++");
  assert.equal(headerLanguage("include/b.h", linkage.replace("char *b(void);", "static const long lang = __cplusplus;")), "c-and-c++");
  for (const directive of ["#define READ(p) (*(int *)0)", "#undef READ", '#include "cxx.h"']) {
    assert.equal(headerLanguage("include/b.h", linkage.replace('extern "C" {', `${directive}\nextern "C" {`)), "c-and-c++", directive);
    assert.equal(headerLanguage("include/b.h", `#ifndef __cplusplus\n${directive}\n#endif\n${linkage}`), "c-and-c++", directive);
  }
  // Linkage boilerplate defined per language, a message, a null directive or another pragma
  // changes nothing there.
  const declarations = "#ifdef __cplusplus\n# define BEGIN_DECLS extern \"C\" {\n# define END_DECLS }\n#else\n# define BEGIN_DECLS\n"
    + "# define END_DECLS\n#endif\nBEGIN_DECLS\nint f(void);\nEND_DECLS\n";
  assert.equal(headerLanguage("include/c.h", declarations), "c-linkage");
  assert.equal(headerLanguage("include/b.h", linkage.replace('extern "C" {', '#error "C only"\n#pragma pack(push, 1)\nextern "C" {')), "c-linkage");
  for (const directive of ["#pragma once", "#pragma GCC diagnostic ignored \"-Wpadded\"", "#pragma clang diagnostic push", "#warning old", "#ident \"x\"", "#"]) {
    assert.equal(headerLanguage("include/b.h", linkage.replace('extern "C" {', `${directive}\nextern "C" {`)), "c-linkage", directive);
  }
  // A pragma that saves or restores a definition, renames an include or imports a module, a
  // line directive (`__LINE__`, `__FILE__`) and `#embed` do, in a group of either language.
  for (const directive of ['#pragma push_macro("READ")', '#pragma pop_macro("READ")', '# pragma  pop_macro ("READ")',
    '#pragma include_alias("a.h", "b.h")', "#pragma clang module import std", '#line 100 "x.h"', '# 100 "x.h"', "#embed <x.bin>"]) {
    assert.equal(headerLanguage("include/b.h", linkage.replace('extern "C" {', `${directive}\nextern "C" {`)), "c-and-c++", directive);
    assert.equal(headerLanguage("include/b.h", `#ifndef __cplusplus\n${directive}\n#endif\n${linkage}`), "c-and-c++", directive);
  }
  // C++ must read the code C reads, less the lines only C reads, only inside linkage. A
  // pragma operator only C reads, a brace a C++ group opens outside `extern "C" {`, linkage
  // inside a block or a parenthesis (a second linkage block lets a `}` move statements out
  // of one), a linkage macro used inside a block, inside parentheses (stringized) or in a
  // condition after its definition, a macro only one language defines that a condition
  // tests, and braces whose depth cannot be told (a `}` closes one a macro opened, a digraph
  // spells one, a macro defined in a group opens one, branches end at different depths and
  // no group repeats their conditions) make it a header of both languages.
  const body = "static inline void put(char *d, const char *s, unsigned n) {\n  if (n <= 8) { d[0] = 0;\n  __builtin_memcpy(d, s, n); }\n}\n";
  assert.equal(headerLanguage("include/b.h", linkage.replace("char *b(void);", body)), "c-linkage");
  const inline = "#if USE_INLINE\nstatic inline int *mk(void) {\n#else\nint *mk(void);\n#endif\n";
  for (const [label, text] of [
    ["_Pragma in c-only code", linkage.replace("char *b(void);", '#ifndef __cplusplus\n_Pragma("pop_macro(\\"READ\\")")\n#endif\n')],
    ["__pragma in c-only code", linkage.replace("char *b(void);", "static inline int g(void) {\n#ifndef __cplusplus\n  __pragma(warning(pop))\n#endif\n  return 0;\n}\n")],
    ["c++-only code in the #else of #if 0", linkage.replace("char *b(void);", "#if 0\nchar *b(void);\n#else\n#ifdef __cplusplus\ninline int g() { return 1; }\n#endif\n#endif\n")],
    ["linkage inside a parenthesis", linkage.replace("char *b(void);", "int f(int a,\n#ifdef __cplusplus\n}\nextern \"C\" {\n#endif\nint b);\n")],
    ["block in c++", linkage.replace("char *b(void);", body.replace("{ d[0] = 0;", "\n#ifdef __cplusplus\n{\n#endif\n d[0] = 0;")
      .replace("n); }", "n);\n#ifdef __cplusplus\n}\n#endif\n}"))],
    ["block outside linkage", linkage.replace('extern "C" {', "{")],
    ["linkage inside a block", linkage.replace("char *b(void);", body.replace("d[0] = 0;", "d[0] = 0;\n#ifdef __cplusplus\n}\n#endif\n")
      .replace("n); }\n}\n", "n); }\n}\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n"))],
    ["linkage macro inside a block", declarations.replace("int f(void);", body.replace("d[0] = 0;", "d[0] = 0; END_DECLS"))],
    ["linkage macro in a condition", declarations.replace("BEGIN_DECLS\nint", "#ifdef END_DECLS\nint g(void);\n#endif\nBEGIN_DECLS\nint")],
    ["c++-only macro tested", linkage.replace("char *b(void);", "#ifdef __cplusplus\n#define CXX_PROTO\n#endif\n#ifdef CXX_PROTO\nint g(void);\n#endif")],
    ["open brace a group's definition gives", linkage.replace("char *b(void);", "#ifdef X\n#define BLOCK {\n#endif\nvoid f(void) BLOCK }")],
    ["open brace a definition gives, then linkage", linkage.replace("char *b(void);", "#define BLOCK {\n#define END }\nstatic inline void g(void) BLOCK\n"
      + "#ifdef __cplusplus\n}\nextern \"C\" {\n#endif\n  h();\nEND\n")],
    ["a function-like brace macro not called", linkage.replace("char *b(void);", "#define CLOSE() }\n#define OPEN() {\nvoid f(void) { int CLOSE = 1;\n"
      + "#ifdef __cplusplus\n}\nextern \"C\" {\n#endif\n  int OPEN = 2; }\n")],
    ["a macro built from a brace macro", linkage.replace("char *b(void);", "#define OPEN {\n#define BEGIN OPEN\n#define CLOSE }\n#define FINISH CLOSE\n"
      + "void f(void) BEGIN\n#ifdef __cplusplus\n}\nextern \"C\" {\n#endif\nFINISH\n")],
    ["branches at different depths", linkage.replace("char *b(void);", "#if X\nvoid f(void);\n#else\nvoid f(void) {\n#endif\n")],
    ["a group without #else that closes a brace", linkage.replace("char *b(void);", "void f(void) {\n#if X\n}\n#endif\n")],
    // Only the next group, with the same conditions and nothing in the first that can change
    // them, brings branches at different depths back to one.
    ["another group after branches at different depths", linkage.replace("char *b(void);", `${inline}#if OTHER\n#endif\n#if USE_INLINE\n  return 0;\n}\n#endif\n`)],
    ["code after branches at different depths", linkage.replace("char *b(void);", `${inline}int x;\n#if USE_INLINE\n  return 0;\n}\n#endif\n`)],
    ["a repeated group with another #elif", linkage.replace("char *b(void);", inline.replace("#else", "#elif B")
      + "#if USE_INLINE\n  return 0;\n}\n#elif C\n#endif\n")],
    ["a repeated group with fewer branches", linkage.replace("char *b(void);", inline.replace("#else", "#elif B\nint *mk(void);\n#else")
      + "#if USE_INLINE\n  return 0;\n}\n#endif\n")],
    ["a redefinition inside the group", linkage.replace("char *b(void);", inline.replace("#else", "#undef USE_INLINE\n#else")
      + "#if USE_INLINE\n  return 0;\n}\n#endif\n")],
    ["a pragma operator inside the group", linkage.replace("char *b(void);", inline.replace("#else", '_Pragma("pop_macro(\\"USE_INLINE\\")")\n#else')
      + "#if USE_INLINE\n  return 0;\n}\n#endif\n")],
    ["branches at different depths at the end", `#ifdef __cplusplus\nextern "C"\n#endif\nint b(void);\n${inline}`],
    ["a condition on __LINE__", linkage.replace("char *b(void);", inline.replaceAll("USE_INLINE", "__LINE__ > 9")
      + "#if __LINE__ > 9\n  return 0;\n}\n#endif\n")],
    ["a condition on __COUNTER__", linkage.replace("char *b(void);", inline.replaceAll("USE_INLINE", "__COUNTER__ % 2")
      + "#if __COUNTER__ % 2\n  return 0;\n}\n#endif\n")],
    ["an include inside the group", linkage.replace("char *b(void);", inline.replace("#else", '#include "inline.h"\n#else')
      + "#if USE_INLINE\n  return 0;\n}\n#endif\n")],
    ["a pragma that restores a definition inside the group", linkage.replace("char *b(void);",
      inline.replace("#else", '#pragma push_macro("USE_INLINE")\n#else') + "#if USE_INLINE\n  return 0;\n}\n#endif\n")],
    ["a repeated group whose condition differs after its first word", linkage.replace("char *b(void);",
      inline.replaceAll("USE_INLINE", "A && B") + "#if A && C\n  return 0;\n}\n#endif\n")],
    ["an enclosing branch ending at different depths", linkage.replace("char *b(void);", "#ifdef X\n#if !USE_INLINE\nint *mk(void);\n#else\n"
      + "static inline int *mk(void) {\n#endif\n#endif\n#if !USE_INLINE\n#else\n  return 0;\n}\n#endif\n")],
    ["a macro built from a linkage macro inside a block", declarations.replace("int f(void);", "#define DECL END_DECLS\nvoid f(void) { DECL }")],
    ["a boilerplate macro redefined outside the groups", declarations.replace("BEGIN_DECLS\nint", "#define END_DECLS\nBEGIN_DECLS\nint")],
    ["linkage macro stringized", declarations.replace("int f(void);", "static const char tag[] = XSTR(END_DECLS);")],
    ["linkage macro inside a definition's parentheses", declarations.replace("int f(void);", "#define TAG XSTR(END_DECLS)")],
    ["linkage macro removed", `${declarations}#undef END_DECLS\n`],
    ["close brace with none open", linkage.replace("char *b(void);", "void f(void) OPEN_FROM_ELSEWHERE\n}\nstatic inline void g(void) {\n"
      + "#ifdef __cplusplus\n}\n#endif\n  h();\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n")],
    ["digraph brace", linkage.replace("char *b(void);", "struct s <% int x; %>;")],
  ]) assert.equal(headerLanguage("include/b.h", text), "c-and-c++", label);
  // A `}` with no `{` open makes the depth unknown, also where nothing else does: here a
  // macro of another header opened the block the first `}` closes.
  const opened = "#ifndef B_H\n#define B_H\n#include \"open.h\"\n#ifdef __cplusplus\nextern \"C\" {\n#endif\nOPEN_CHECKED_BLOCK(p)\n}\n"
    + "#ifdef __cplusplus\n}\nextern \"C\" {\n#endif\n  return p[0];\n}\n#ifdef __cplusplus\n}\n#endif\n#endif\n";
  assert.equal(headerLanguage("include/b.h", opened), "c-and-c++");
  // Code only C reads anywhere (C++ reads the rest: a member or a check less), braces
  // counted where a macro is used and per branch (or per branch of the group that repeats a
  // split group's conditions), groups no compiler takes (`#if 0`, as in the cc-mode idiom),
  // boilerplate macros built from linkage macros or tested before the header defines them,
  // and linkage macros in lines only C reads keep a C header with C++ linkage.
  const vec = "typedef struct vec { int *data; unsigned len; } vec;\nstatic inline int vec_init(vec *v, unsigned n)\n{\n"
    + "  v->data = malloc(n * sizeof *v->data);\n  if (v->data == NULL)\n    return -1;\n  v->len = n;\n  return 0;\n}\n";
  for (const [label, text] of [
    ["c-only declarations", linkage.replace("char *b(void);", "#ifndef __cplusplus\ntypedef int bool;\n#endif\n")],
    ["c-only typedef after a declaration", linkage.replace("char *b(void);", "struct vec { int *data; };\n#ifndef __cplusplus\ntypedef struct vec vec;\n#endif\n"
      + "static inline int vec_first(struct vec *v) { return v->data[0]; }\n")],
    ["c-only group after a linkage macro", declarations.replace("int f(void);", "#ifndef __cplusplus\ntypedef unsigned char bool_t;\n#endif\nint f(void);")],
    ["c-only code in a declaration", linkage.replace("char *b(void);", "struct s { int a;\n#ifndef __cplusplus\n  int b;\n#endif\n};\n")],
    ["c-only member named like a C++ keyword", linkage.replace("char *b(void);", "struct key_params {\n  union {\n#ifndef __cplusplus\n    int private;\n"
      + "#endif\n    int priv;\n  };\n};\n")],
    ["c-only body after a head", linkage.replace("char *b(void);", "static inline int g(int *p)\n#ifndef __cplusplus\n{ if (!p) return 0; return *p; }\n"
      + "static inline int h(int *p)\n#endif\n{ return *p; }\n")],
    ["c-only code ending inside a declaration", linkage.replace("char *b(void);", "#ifndef __cplusplus\nstatic\n#endif\nint g(void);\n")],
    ["c-only code after a declaration's start", linkage.replace("char *b(void);", "int\n#ifndef __cplusplus\n*p;\n#endif\n")],
    ["c-only check", linkage.replace("char *b(void);", "static inline unsigned cap(unsigned n) {\n#ifndef __cplusplus\n  if (n > 8) n = 8;\n#endif\n  return n;\n}")],
    ["a c-only empty macro inside c-only parentheses", linkage.replace("char *b(void);", "#ifndef __cplusplus\n# define NO_ARG\n"
      + "extern void *legacy_alloc(NO_ARG);\n#endif\n")],
    ["a linkage macro inside c-only parentheses", declarations.replace("int f(void);", "int f(void);\n#ifndef __cplusplus\nint g(int END_DECLS);\n#endif\n")],
    ["a function body split over two groups of one condition", linkage.replace("char *b(void);", `${inline}#if USE_INLINE\n  return 0;\n}\n#endif\n`)],
    ["and over three", linkage.replace("char *b(void);", `${inline}\n#if USE_INLINE\n  int *p = 0;\n#endif\n#if USE_INLINE\n  return p;\n}\n#endif\n`)],
    ["with #elif and #else", linkage.replace("char *b(void);", inline.replace("#else", "#elif SHORT\nstatic inline int *mk(void) { int *p = 0;\n#else")
      + "#if USE_INLINE\n  return 0;\n}\n#elif SHORT\n  return p;\n}\n#endif\n")],
    ["with further #elif within the #else", linkage.replace("char *b(void);", "#if USE_INLINE\nvoid f(void) {\n#else\nvoid f(void) { {\n#endif\n"
      + "#if USE_INLINE\n}\n#elif FAST\n} }\n#else\n} }\n#endif\n")],
    ["cc-mode braces", linkage.replace('extern "C" {\n#endif', 'extern "C" {\n#if 0\n} /* satisfy cc-mode */\n#endif\n#endif')
      .replace("#ifdef __cplusplus\n}", "#ifdef __cplusplus\n#if 0\n{ /* satisfy cc-mode */\n#endif\n}").replace("char *b(void);", vec)],
    ["export macro", "#ifndef V_H\n#define V_H\n#ifdef __cplusplus\n#  define V_EXTERN_C extern \"C\"\n#else\n#  define V_EXTERN_C\n#endif\n"
      + "#if defined(_WIN32) && defined(V_DLL)\n#  define V_EXPORT __declspec(dllexport)\n#else\n#  define V_EXPORT\n#endif\n"
      + "#define V_API V_EXTERN_C V_EXPORT\n" + vec + "V_API int vec_resize(vec *v, unsigned n);\n#endif\n"],
    ["guarded boilerplate", "#ifndef V_BEGIN_DECLS\n#  ifdef __cplusplus\n#    define V_BEGIN_DECLS extern \"C\" {\n#    define V_END_DECLS }\n"
      + "#  else\n#    define V_BEGIN_DECLS\n#    define V_END_DECLS\n#  endif\n#endif\nV_BEGIN_DECLS\n" + vec + "V_END_DECLS\n"],
    ["block macros", linkage.replace("char *b(void);", vec + "#define V_LOCKED(v) { vec *locked_ = (v); vec_lock(locked_);\n"
      + "#define V_LOCKED_RO(v) { const vec *locked_ = (v); vec_lock((vec *)locked_);\n#define V_UNLOCK() vec_unlock((vec *)locked_); }\n"
      + "static inline void vec_clear(vec *v) V_LOCKED(v) v->len = 0; V_UNLOCK()\n")],
    ["split function head", linkage.replace("char *b(void);", vec + "#if defined(V_WIDE)\nstatic inline long vec_sum(const vec *v) {\n  long sum = 0;\n"
      + "#else\nstatic inline int vec_sum(const vec *v) {\n  int sum = 0;\n#endif\n  for (unsigned i = 0; i < v->len; i++)\n    sum += v->data[i];\n"
      + "  return sum;\n}\n")],
    ["dead code tests __cplusplus", linkage.replace("char *b(void);", "#if 0\n#if __cplusplus > 1\n#endif\nint x = __cplusplus;\n#endif\nchar *b(void);")],
    ["a brace macro named before its definition", linkage.replace("char *b(void);", "int OPEN;\n#define OPEN {\nchar *b(void);")],
    ["a directive in a group no compiler takes", linkage.replace('extern "C" {', '#if 0\n#include "cxx.h"\n#endif\nextern "C" {')],
  ]) assert.equal(headerLanguage("include/b.h", text), "c-linkage", label);
  // Linkage may span lines, and stand before one declaration.
  assert.equal(headerLanguage("include/b.h", linkage.replace('extern "C" {', 'extern "C"\n{')), "c-linkage");
  assert.equal(headerLanguage("include/b.h", "#ifdef __cplusplus\nextern \"C\"\n#endif\nint f(void);\n"), "c-linkage");
  // A lone CR and CR LF end a line as LF does, also in a directive's own line.
  for (const end of ["\r\n", "\r", "\n\r"]) {
    assert.equal(headerLanguage("include/b.h", linkage.replaceAll("\n", end)), "c-linkage", JSON.stringify(end));
    assert.equal(headerLanguage("include/b.h", linkage.replace("#ifdef __cplusplus\nextern", "#if __cplusplus >= 201103L\nextern")
      .replaceAll("\n", end)), "c-linkage", JSON.stringify(end));
    const conly = linkage.replace("#endif\nchar", `#else\n#define READ(p) (*(p))${end}#endif\nchar`);
    assert.equal(headerLanguage("include/b.h", conly), "c-and-c++", JSON.stringify(end));
    assert.equal(headerLanguage("x.h", "#ifdef __OBJC__\n@class NSData;\n#endif\nint f(void);\n".replaceAll("\n", end)), null, JSON.stringify(end));
  }
  // Objective-C markers only under a condition: a header no portable unit can see is
  // compiled with a visible Objective-C unit, and without one it is not analyzed.
  const bridgeRoot = fixture(t);
  mkdirSync(join(bridgeRoot, "mac"));
  const bridge = "#pragma once\n#ifdef __OBJC__\n@class NSView;\n#endif\nvoid bridge(void);\n";
  writeFileSync(join(bridgeRoot, "mac/bridge.h"), bridge);
  const mixed = [{ file: "src/b.cpp" }, { file: "mac/view.mm" }, { file: "mac/bridge.h", source: bridge }];
  const languages = [];
  const compiled = await analyzeNative(bridgeRoot, mixed, [units[1], units[2]], async (_command, args) => {
    languages.push(args[args.indexOf("-x") + 1]);
    return { ok: true, exitCode: 0 };
  }, { host: {}, changed: new Set(["mac/bridge.h"]) });
  assert.deepEqual([compiled.map(item => `${item.file}:${item.status}`), languages],
    [["mac/bridge.h:passed"], ["objective-c++-header", "objective-c++-header", "objective-c++"]]);
  assert.deepEqual(await analyzeNative(bridgeRoot, mixed, [units[1]], async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["mac/bridge.h"]) }), []);
  // With both kinds configured, whatever their order, a header with C++ in it is compiled
  // with the Objective-C++ unit and a C one with the Objective-C unit; an Objective-C unit
  // alone does not compile C++.
  const engine = "#pragma once\n#ifdef __OBJC__\n@class Window;\n#endif\nclass Engine { public: int frame(); };\n";
  const unconditional = "#pragma once\n@class Window;\nclass Engine { public: int frame(); };\n";
  writeFileSync(join(bridgeRoot, "mac/engine.h"), engine);
  writeFileSync(join(bridgeRoot, "mac/window.h"), unconditional);
  const platform = [...mixed, { file: "mac/app.m" }, { file: "mac/engine.h", source: engine }, { file: "mac/window.h", source: unconditional }];
  const appUnit = { file: "mac/app.m", standard: "c17" };
  const compiledAs = async (configured, header) => {
    const seen = new Set();
    const outcome = await analyzeNative(bridgeRoot, platform, configured, async (_command, args) => {
      seen.add(args[args.indexOf("-x") + 1]);
      return { ok: true, exitCode: 0 };
    }, { host: {}, changed: new Set([header]) });
    return [outcome.map(item => item.status), [...seen].sort()];
  };
  for (const header of ["mac/engine.h", "mac/window.h"]) {
    for (const configured of [[appUnit, units[2]], [units[2], appUnit]]) {
      assert.deepEqual(await compiledAs(configured, header), [["passed"], ["objective-c++", "objective-c++-header"]], header);
    }
    assert.deepEqual(await compiledAs([appUnit], header), [[], []], header);
  }
  assert.deepEqual(await compiledAs([units[2], appUnit], "mac/bridge.h"), [["passed"], ["objective-c", "objective-c-header"]]);
  assert.deepEqual(unanalyzedPlatformUnits(mixed, [units[1]], new Set(["mac/bridge.h"])), ["mac/bridge.h"]);
  // A portable unit that sees it, of another language, still makes it a configuration error.
  writeFileSync(join(bridgeRoot, "mac/bridge.hpp"), bridge);
  const plain = [...mixed, { file: "mac/plain.c" }, { file: "mac/bridge.hpp", source: bridge }];
  assert.deepEqual(await analyzeNative(bridgeRoot, plain, [units[2], { file: "mac/plain.c", standard: "c17" }],
    async () => assert.fail("must not compile"), { host: {}, changed: new Set(["mac/bridge.hpp"]) }),
  [{ rule: "native.configuration-required", status: "error" }]);
  // C++ that reaches a C header with C++ linkage only through other headers, of either
  // language, compiles it as C++ too; without that chain it is compiled as C alone.
  const chainRoot = fixture(t);
  mkdirSync(join(chainRoot, "src"));
  const chain = { "src/main.c": '#include "api.h"\nint main(void) { return 0; }\n', "src/app.cpp": '#include "both.h"\nint run() { return 0; }\n',
    "src/both.h": '#pragma once\n#include "api.h"\n', "src/api.h": linkage };
  for (const [file, text] of Object.entries(chain)) writeFileSync(join(chainRoot, file), text);
  const chainStandards = async sources => {
    const standards = new Set();
    await analyzeNative(chainRoot, sources, [{ file: "src/main.c", standard: "c17" }, { file: "src/app.cpp", standard: "c++20" }],
      async (_command, args) => { standards.add(args.find(arg => arg.startsWith("-std="))); return { ok: true, exitCode: 0 }; },
      { host: {}, changed: new Set(["src/api.h"]) });
    return [...standards].sort();
  };
  const chainSources = Object.entries(chain).map(([file, source]) => ({ file, source }));
  assert.deepEqual(await chainStandards(chainSources), ["-std=c++20", "-std=c17"]);
  assert.deepEqual(await chainStandards(chainSources.map(item => item.file === "src/both.h" ? { ...item, source: "#pragma once\n" } : item)),
    ["-std=c17"]);
  // A C++-only header is read as C++ wherever it is included, so what it includes is too.
  assert.deepEqual(await chainStandards(chainSources.map(item => item.file === "src/both.h"
    ? { ...item, source: '#pragma once\n#include "api.h"\nnamespace lib { int both(); }\n' }
    : item.file === "src/app.cpp" ? { ...item, source: "int run() { return 0; }\n" } : item)), ["-std=c++20", "-std=c17"]);
  // Reading the conditional structure stays linear on adversarial input.
  const started = performance.now();
  for (const unit of ["#if 1\n", "#ifndef A\n#endif\n", "#ifdef __cplusplus\n", "[[x", "#else\n", "#if !defined(A)\n",
    "#ifdef __cplusplus\nextern \"C\" {\n#endif\n", "#elif __cplusplus\n"]) {
    headerLanguage("x.h", "#ifndef A\n#define A\n" + unit.repeat(Math.floor(2 * 1024 * 1024 / unit.length)));
  }
  assert.ok(performance.now() - started < 20_000);
  // A directive line that holds a CR, with blanks after its `#` (a masked comment) in a
  // language group, took seconds at a few thousand blanks (backtracking cubic in them).
  const crLine = performance.now();
  for (const head of [`#${" ".repeat(4000)}define X 1\r`, `#/*${"x".repeat(4000)}*/define X 1\r`]) {
    headerLanguage("x.h", `#ifdef __cplusplus\n${head}\n#else\n${head}\n#endif\n`);
  }
  assert.ok(performance.now() - crLine < 2_000);
  // So do 2 MiB inputs against the language-group checks, with each line end.
  const half = 1024 * 1024, groups = text => `#ifdef __cplusplus\n${text}\n#else\n${text}\n#endif\n`;
  const declared = text => `#ifdef __cplusplus\n#define BEGIN extern "C" {\n#else\n#define BEGIN\n#endif\nBEGIN\n${text}\n`;
  const groupChecks = performance.now();
  for (const end of ["\r", "\r\n", "\n"]) {
    for (const text of [groups(`#${" ".repeat(half)}define X 1${end}`), groups(`#/*${"x".repeat(half)}*/define X 1${end}`),
      groups(`#define F(${"a".repeat(half)}${end}`), groups(`#pragma${" ".repeat(half)}pop_macro${end}`),
      declared(`int a <${" ".repeat(2 * half)}b;${end}`), declared(`BEGIN int a;${end}`.repeat(2 * half / 13)),
      `{${end}`.repeat(half) + groups("}")]) {
      headerLanguage("x.h", text);
    }
  }
  assert.ok(performance.now() - groupChecks < 20_000);
});

test("real clang: the analyzer reads the code the compiler builds, and C units may use bounded APIs", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const hidden = "#define PASTE2(a, b) a##b\n#define PASTE(a, b) PASTE2(a, b)\nint f(int* p) {\n#if !PASTE(__clang_, analyzer__)\n  p = 0;\n#endif\n  return *p;\n}\n";
  assert.equal((await analyzeWithClang(t, { "hide.cpp": hidden }, [{ file: "hide.cpp", standard: "c++20" }]))[0].status, "failed");
  const bounded = "#include <stdio.h>\n#include <string.h>\nint f(char* d, const char* s, int n) {\n  int w = snprintf(d, 8, \"%d\", n);\n  memcpy(d, s, 4);\n  memset(d, 0, 8);\n  return w;\n}\n";
  assert.equal((await analyzeWithClang(t, { "fmt.c": bounded }, [{ file: "fmt.c", standard: "c17" }]))[0].status, "passed");
});

test("real clang: a returning function named like an exit handler hides no report, and noreturn calls end paths", { skip: (!clangAvailable() && "clang++ is not installed") || (process.platform === "win32" && "Windows keeps the analyzer's list of exit-handler names") }, async (t) => {
  // glibc's error() returns when its status is 0; the analyzer took every call of a global
  // C function named error, panic or Assert for an exit. A method is not one (method.cpp
  // failed with the list too).
  const hidden = {
    "error.c": "#include <stdlib.h>\nvoid error(int status, int errnum, const char *format, ...);\n"
      + "int f(int *p) { free(p); error(0, 0, \"freed\"); return *p; }\n",
    "panic.c": "void panic(const char *message);\nint f(int *p) { if (!p) panic(\"null\"); return *p; }\n",
    "method.cpp": "#include <cstdlib>\nstruct Log { void error(const char *message); };\n"
      + "int f(Log &log, int *p) { std::free(p); log.error(\"freed\"); return *p; }\n",
  };
  for (const [file, text] of Object.entries(hidden)) {
    const standard = file.endsWith(".c") ? "c17" : "c++20";
    assert.equal((await analyzeWithClang(t, { [file]: text }, [{ file, standard }]))[0].status, "failed", file);
  }
  const ending = {
    "ending.c": "#include <stdlib.h>\n#include <assert.h>\n_Noreturn void die(void);\n__attribute__((noreturn)) void fatal(void);\n"
      + "int a(int *p) { if (!p) exit(1); return *p; }\nint b(int *p) { if (!p) abort(); return *p; }\n"
      + "int c(int *p) { if (!p) die(); return *p; }\nint d(int *p) { if (!p) fatal(); return *p; }\n"
      + "int e(int *p) { assert(p); return *p; }\n",
    "ending.cpp": "#include <cstdlib>\n#include <cassert>\n[[noreturn]] void die();\n"
      + "int a(int *p) { if (!p) std::exit(1); return *p; }\nint c(int *p) { if (!p) die(); return *p; }\n"
      + "int e(int *p) { assert(p); return *p; }\nint t(int *p) { if (!p) throw 1; return *p; }\n",
  };
  for (const [file, text] of Object.entries(ending)) {
    const standard = file.endsWith(".c") ? "c17" : "c++20";
    assert.equal((await analyzeWithClang(t, { [file]: text }, [{ file, standard }]))[0].status, "passed", file);
  }
  // The accepted price: glibc's error() with a nonzero status does not return, but nothing
  // declares it so (glibc's own declaration, repeated here so that hosts without <error.h>
  // run the case too), and the GNU guard `if (!p) error(EXIT_FAILURE, ...);` lets the null
  // path continue to a report. Ending the path in the code (abort() after the call) passes.
  const guard = "#include <stdlib.h>\n#include <string.h>\nvoid error(int status, int errnum, const char *format, ...);\n"
    + "char *duplicate(const char *text) {\n  size_t size = strlen(text) + 1;\n  char *copy = malloc(size);\n"
    + "  if (copy == NULL) %s\n  memcpy(copy, text, size);\n  return copy;\n}\n";
  for (const [ending, status] of [['error(EXIT_FAILURE, 0, "out of memory");', "failed"],
    ['{ error(EXIT_FAILURE, 0, "out of memory"); abort(); }', "passed"]]) {
    const text = guard.replace("%s", ending);
    assert.equal((await analyzeWithClang(t, { "copy.c": text }, [{ file: "copy.c", standard: "c17" }]))[0].status, status, ending);
  }
});

test("real clang: the analyzer's suppress attribute is rejected however the source reaches the word", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const deref = attribute => `int deref(int* p) {\n  if (p) return 0;\n  ${attribute} return *p;\n}\n`;
  // Each reaches the attribute only through expansion, which the expansion pass reads.
  const hidden = {
    "alias.cpp": ["#define QUIET suppress\n" + deref("[[clang::QUIET]]"), 4],
    "param.cpp": ["#define ATTR(x) [[clang::x]]\n" + deref("ATTR(suppress)"), 4],
    "paste.cpp": ["#define CAT2(a, b) a##b\n#define CAT(a, b) CAT2(a, b)\n" + deref("[[clang::CAT(supp, ress)]]"), 5],
    "using.cpp": ["#define NS clang\n" + deref("[[using NS: suppress]]"), 4],
    "gnu.c": [deref("__attribute((suppress))"), 3],
    "gnu-alias.c": ["#define QUIET __suppress__\n" + deref("__attribute__((QUIET))"), 4],
    "header.cpp": ['#include "quiet.h"\n' + deref("QUIET_ATTRIBUTE"), 4],
    // A pragma clang accepts without -fopenmp neither hides the attribute nor ends it early.
    "omp.cpp": ["#define QUIET suppress\n#pragma omp parallel [[\n" + deref("[[clang::QUIET]]"), 5],
    "omp.c": ["#define QUIET suppress\n#pragma omp parallel __attribute__((\n" + deref("__attribute__((QUIET))"), 5],
    "omp-param.cpp": ["#pragma omp declare [[\n#define ATTR(x) [[clang::x]]\n" + deref("ATTR(suppress)"), 5],
    "omp-close.cpp": ["#define QUIET suppress\nint deref(int* p) {\n  if (p) return 0;\n  [[clang::\n#pragma omp parallel ]\n"
      + "  QUIET]] return *p;\n}\n", 6],
    // A line inside a raw string is never a linemarker, also in a pragma.
    "raw.cpp": ['#define QUIET suppress\nconst char *s = R"(\n# 1 "/usr/include/stdio.h" 3\n)";\n' + deref("[[clang::QUIET]]"), 7],
    "pragma-raw.cpp": ['#define QUIET suppress\n#pragma omp R"(\n# 1 "/usr/include/stdio.h" 3\n)"\n' + deref("[[clang::QUIET]]"), 7],
  };
  for (const [file, [text, line]] of Object.entries(hidden)) {
    const standard = file.endsWith(".c") ? "c17" : "c++20";
    const scanned = await scanWithClang(t, { [file]: text, "quiet.h": "#define QUIET_ATTRIBUTE [[clang::suppress]]\n" },
      [{ file, standard }], [file]);
    assert.deepEqual(scanned.checks, [`${file}:failed`], file);
    assert.ok(scanned.findings.includes(`native.analysis-suppression@${file}:${line}`), `${file}: ${scanned.findings}`);
    // A line the policy rule and the expansion pass both report is reported once.
    assert.equal(new Set(scanned.findings).size, scanned.findings.length, `${file}: ${scanned.findings}`);
  }
  // A header job reads the same way, and a hit is reported in the repository file whose
  // line applies the attribute, not in the analyzed file.
  const header = await scanWithClang(t, { "src/a.cpp": "int z;\n", "src/q.hpp": "#pragma once\n#define QUIET suppress\n#pragma omp parallel [[\ninline "
    + deref("[[clang::QUIET]]") }, [{ file: "src/a.cpp", standard: "c++20" }], ["src/q.hpp"]);
  assert.deepEqual([header.checks, header.findings], [["src/q.hpp:failed"], ["native.analysis-suppression@src/q.hpp:6"]]);
  const included = await scanWithClang(t, { "src/u.cpp": '#include "deref.hpp"\nint use() { return 0; }\n',
    "src/deref.hpp": "#pragma once\n#define QUIET suppress\ninline " + deref("[[clang::QUIET]]") }, [{ file: "src/u.cpp", standard: "c++20" }],
  ["src/u.cpp"]);
  assert.deepEqual([included.checks, included.findings], [["src/u.cpp:failed"], ["native.analysis-suppression@src/deref.hpp:5"]]);
  const configured = await scanWithClang(t, { "cfg.cpp": deref("[[clang::QUIET]]") },
    [{ file: "cfg.cpp", standard: "c++20", defines: ["QUIET=suppress"] }], ["cfg.cpp"]);
  assert.ok(configured.findings.includes("native.analysis-suppression@cfg.cpp:3"), configured.findings.join());
  // Nothing is renamed or defined for analysis, so no condition sees a different unit.
  const freeThenRead = "int g(int *p) { std::free(p); return *p; }\n", read = "int g(int *p) { return *p; }\n";
  const observers = {
    "ifdef.cpp": `#include <cstdlib>\n#ifdef suppress\n${read}#else\n${freeThenRead}#endif\n`,
    "hasattr.cpp": `#include <cstdlib>\n#if __has_cpp_attribute(clang::suppress)\n${freeThenRead}#else\n${read}#endif\n`,
    "spelled.cpp": "#include <cstdlib>\n#define STR2(x) #x\n#define STR(x) STR2(x)\n"
      + "int g(int *p) {\n  if constexpr (sizeof(STR(suppress)) > 9) return *p;\n  else { std::free(p); return *p; }\n}\n",
  };
  for (const [file, text] of Object.entries(observers)) {
    assert.equal((await analyzeWithClang(t, { [file]: text }, [{ file, standard: "c++20" }]))[0].status, "failed", file);
  }
  // Ordinary names compile unchanged: a member, parameter or function named suppress, a
  // function named in an attribute's argument, the GSL suppression the analyzer ignores
  // and an MSVC-only warning pragma.
  const valid = {
    "named.cpp": "struct Logger { bool suppress = false; void set(bool suppress) { this->suppress = suppress; } };\n"
      + "static int suppress(int x) { return x + 1; }\nint use() { Logger l; l.set(true); return suppress(1) + l.suppress; }\n"
      + "int gsl(int *p) { [[gsl::suppress(\"type.1\")]] return p ? *p : 0; }\n",
    "cleanup.c": "static void suppress(int *p) { (void)p; }\nint f(void) { __attribute__((cleanup(suppress))) int x = 0; return x; }\n",
    "msvc.c": "#if defined(_MSC_VER)\n#define UNUSED(x) __pragma(warning(suppress: 4100)) x\n#else\n#define UNUSED(x) x\n#endif\n"
      + "int f(int UNUSED(a)) { (void)a; return 0; }\n",
  };
  for (const [file, text] of Object.entries(valid)) {
    const findings = [];
    const outcomes = await analyzeWithClang(t, { [file]: text }, [{ file, standard: file.endsWith(".c") ? "c17" : "c++20" }],
      undefined, findings);
    assert.deepEqual([outcomes[0].status, findings], ["passed", []], file);
  }
});

test("the expansion pass reads attributes after expansion, outside system headers, in linear time", () => {
  const cxx = { rawStrings: true, digitSeparators: true, moduleImports: true };
  const output = ['# 1 "src/a.cpp"', '# 1 "/usr/include/lib.h" 1 3 4', "[[clang::suppress]] int lib;",
    '# 2 "src/a.cpp" 2', "int f(int *p) {", "  [[clang :: suppress]] return *p;", "}",
    '# 1 "./d\\303\\251/q.h" 1', "int g(int *p) { __attribute__((__suppress__)) return *p; }",
    '#line 40 "src/b.h"', "int h(int *p) { <:<:using clang: suppress:>:> return *p; }"].join("\n");
  assert.deepEqual(expandedSuppressions(output, cxx), [{ path: "src/a.cpp", line: 3 }, { path: "./d\u00e9/q.h", line: 1 },
    { path: "src/b.h", line: 40 }]);
  // Names that are not the analyzer's attribute: an argument, a literal, the GSL spelling,
  // an unknown unscoped attribute and Objective-C message sends.
  for (const code of ['__attribute__((cleanup(suppress))) int x;', '[[clang::annotate("suppress")]] int y;',
    '[[gsl::suppress("type.1")]] int z;', "[[using gsl: suppress]] int w;", "[[suppress]] int v;",
    "id a = [[obj suppress] retain]; id b = list[[obj suppress]];", 'R"([[clang::suppress]])";']) {
    assert.deepEqual(suppressAttributeOffsets(maskNativeCode(code, { ...cxx, logical: true })), [], code);
  }
  assert.equal(suppressAttributeOffsets("[[gnu::aligned(sizeof(int[2])), clang::suppress]]").length, 1);
  // System-header text inside an attribute opened in the repository counts as a hit.
  const split = ['# 1 "src/a.cpp"', "int f(int *p) { [[clang::", '# 1 "/usr/include/x.h" 1 3', "suppress", '# 2 "src/a.cpp" 2',
    "]] return *p; }"].join("\n");
  assert.deepEqual(expandedSuppressions(split, cxx).map(hit => hit.path), ["/usr/include/x.h"]);
  assert.deepEqual(expansionLexing(["-E", "-x", "c-header", "-std=c23"]), { rawStrings: false, digitSeparators: true, moduleImports: false });
  // Directive lines carry no attribute: the tokens of a pragma clang accepts without
  // -fopenmp neither open an attribute that hides the rest nor close one early.
  const c = { rawStrings: false, digitSeparators: false, moduleImports: false };
  const unit = (...lines) => ['# 1 "src/a.cpp"', ...lines].join("\n");
  for (const [output, lexing, line] of [
    [unit("#pragma omp parallel [[", "int f(int *p) {", "  [[clang::suppress]] return *p;", "}"), cxx, 3],
    [unit("#pragma omp parallel __attribute__((", "int f(int *p) { __attribute__((suppress)) return *p; }"), c, 2],
    [unit("int f(int *p) {", "  [[clang::", "#pragma omp parallel ]", "  suppress]] return *p;", "}"), cxx, 4],
    [unit("#pragma omp parallel [[ ((", "#ident \"]]\"", "[[clang::suppress]] int x;"), cxx, 3],
    // clang prints a directive's `#` in the first column; a `#` token of code that starts a
    // line (from a macro argument) is printed after a space and stays code.
    [unit(" # [[clang::suppress]] int x;"), cxx, 1],
  ]) assert.deepEqual(expandedSuppressions(output, lexing), [{ path: "src/a.cpp", line }], output);
  assert.equal(holdsObjectiveC(" # @class A;\n", cxx), true);
  // A raw string is text: a line in it is neither a linemarker nor a directive, also in a
  // pragma. clang prints the lines after it lower by its line breaks until its next
  // linemarker, and the hit is reported at the source line.
  const raw = unit('const char *s = R"(', '# 1 "/usr/include/x.h" 1 3', ')";', "", "",
    "int f(int *p) { [[clang::suppress]] return *p; }", '#pragma omp u8R"x(', "#pragma omp parallel [[", ')x"', "", "",
    "int g(int *p) { [[clang::suppress]] return *p; }", '# 40 "src/a.cpp"', "int h(int *p) { [[clang::suppress]] return *p; }");
  assert.deepEqual(expandedSuppressions(raw, cxx), [{ path: "src/a.cpp", line: 4 }, { path: "src/a.cpp", line: 8 },
    { path: "src/a.cpp", line: 40 }]);
  const shader = unit('const char *s = R"glsl(', "#version 330", "#define X [[", "[[x::suppress]]", ')glsl";', "int ok;");
  assert.deepEqual(expandedSuppressions(shader, expansionLexing(["-E", "-w", "-x", "c++", "-std=c++20"])), []);
  assert.deepEqual(expandedSuppressions(shader, expansionLexing(["-E", "-w", "-x", "objective-c++-header", "-std=c++20"])), []);
  // The probe's view: Objective-C syntax is an `@` outside every literal.
  assert.equal(holdsObjectiveC('# 1 "a.h"\n@interface A\n@end\n', cxx), true);
  assert.equal(holdsObjectiveC('const char *s = "@x"; char c = \'@\'; auto r = R"(\n@end\n)";\n', cxx), false);
  // A directive line clang prints (`#pragma`, `#ident`) is not code.
  assert.equal(holdsObjectiveC("#pragma ludiars note @\n#ident \"@\"\nint x;\n", cxx), false);
  const started = performance.now();
  for (const unit of ["[[", "[[x", "__attribute__((", "[[clang::suppress", "(", "# 1 \"a\" 1 3\nx\n", "#pragma omp [[\n",
    'R"(\n', 'R"x(\n# 1 "a" 1 3\n)x"\n', "@"]) {
    const text = unit.repeat(Math.floor(2 * 1024 * 1024 / unit.length));
    expandedSuppressions(text, cxx);
    holdsObjectiveC(text, cxx);
  }
  assert.ok(performance.now() - started < 20_000);
});

// The real gate: a Git checkout scanned end to end, so tracked files and the policy scan
// of what the compiler read are those of a reviewed repository.
async function scanWithClang(t, files, units, changedPaths, links = {}) {
  const root = fixture(t);
  for (const [file, text] of Object.entries({ ...files, "praesidium.json": JSON.stringify({ version: 1, native: units, web: [] }) })) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  for (const [link, target] of Object.entries(links)) symlinkSync(target, join(root, link));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  const report = await scanRepository({ root, changedPaths, nativeHost: {} });
  return { status: report.status, findings: report.findings.map(item => `${item.rule}@${item.file}:${item.line}`),
    checks: report.checks.map(item => `${item.file}:${item.status}`), notAnalyzed: report.coverage?.nativeNotAnalyzed };
}

test("real clang: the baseline leaves nothing a unit can observe and reads nothing from the repository", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  // A guard macro or a macro from a header the baseline included once chose a different
  // branch under analysis than in the product build.
  const guarded = "#include <cstdlib>\n#ifndef PRAESIDIUM_BASELINE_H\nint g(int *p) { std::free(p); return *p; }\n#else\nint g(int *p) { return *p; }\n#endif\n";
  assert.equal((await analyzeWithClang(t, { "a.cpp": guarded }, [{ file: "a.cpp", standard: "c++20" }]))[0].status, "failed");
  const nullGuarded = "#ifndef NULL\n#include <stdlib.h>\nint g(int *p) { free(p); return *p; }\n#else\nint g(int *p) { return *p; }\n#endif\n";
  assert.equal((await analyzeWithClang(t, { "a.c": nullGuarded }, [{ file: "a.c", standard: "c17" }]))[0].status, "failed");
  // No macro the baseline defines is left behind.
  const names = [...new Set(readFileSync(NATIVE_BASELINE_HEADER, "utf8").match(/(?<=#define )PRAESIDIUM_\w+/g))];
  assert.ok(names.length >= 4);
  for (const [file, standard] of [["any.cpp", "c++20"], ["any.c", "c17"]]) {
    const observer = `#include <stdlib.h>\n#if ${names.map(name => `defined(${name})`).join(" || ")}\nint g(int *p) { return *p; }\n`
      + "#else\nint g(int *p) { free(p); return *p; }\n#endif\n";
    assert.equal((await analyzeWithClang(t, { [file]: observer }, [{ file, standard }]))[0].status, "failed", file);
  }
  const header = "#ifndef PRAESIDIUM_BASELINE_H\n#define PRAESIDIUM_BASELINE_H\ninline int copy(int n) { int* p = new int[4](); delete[] p; return p[n]; }\n#endif\n";
  const job = await analyzeWithClang(t, { "src/codec.cpp": "int use() { return 0; }\n", "src/bytes.hpp": header },
    [{ file: "src/codec.cpp", standard: "c++20" }], ["src/bytes.hpp"]);
  assert.deepEqual(job.map(item => item.status), ["failed"]);
  // Repository headers named like standard ones are reached only by the unit's own
  // includes, after the declarations: they can no longer rename or skip them.
  const alias = "#include <cstdio>\n#include <cstring>\n#define FORMAT std::sprintf\nint f(char* d, const char* s) { return FORMAT(d, \"%s!\", s); }\n";
  const shadowed = await scanWithClang(t, {
    "src/a.cpp": alias,
    "include/cstring": "#include_next <cstring>\n#define PRAESIDIUM_UNSAFE_FORTIFIED 1\n",
    "include/cstdio": "#include_next <cstdio>\n#define deprecated nodiscard\n#define __deprecated__ nodiscard\n",
    "src/b.c": "#include <stdio.h>\n#define FORMAT sprintf\nint f(char* d, const char* s) { return FORMAT(d, \"%s!\", s); }\n",
    "include/stddef.h": "#include_next <stddef.h>\n#define __attribute__(x)\n",
  }, [{ file: "src/a.cpp", standard: "c++20", includes: ["include"] }, { file: "src/b.c", standard: "c17", includes: ["include"] }],
  ["src/a.cpp", "src/b.c"]);
  assert.deepEqual(shadowed.checks, ["src/a.cpp:failed", "src/b.c:failed"]);
});

test("real clang: a change to Revisor's own baseline is compiled by its header jobs in C and C++", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  // The running copy is force-included; the reviewed copy is a different file, so with
  // `#pragma once` instead of a guard macro it is compiled, once per language.
  const own = "src/praesidium/native/include/praesidium/baseline.h";
  const text = readFileSync(NATIVE_BASELINE_HEADER, "utf8");
  const fixtures = fileURLToPath(new URL("./fixtures/praesidium-native", import.meta.url));
  const files = { "test/fixtures/praesidium-native/bounded_apis.c": readFileSync(join(fixtures, "bounded_apis.c"), "utf8"),
    "test/fixtures/praesidium-native/bounded_apis.cpp": readFileSync(join(fixtures, "bounded_apis.cpp"), "utf8") };
  const units = JSON.parse(readFileSync(fileURLToPath(new URL("../praesidium.json", import.meta.url)), "utf8")).native;
  const run = async header => (await analyzeWithClangSources(t, { ...files, [own]: header }, units, [own])).map(item => item.status);
  assert.deepEqual(await run(`${text}/* touched */\n`), ["passed", "passed"]);
  assert.deepEqual(await run(text.replace("namespace std {", "this is not C++;\nnamespace std {")), ["passed", "failed"]);
  assert.deepEqual(await run(text.replace("#else\n", "#else\nthis is not C;\n")), ["failed", "passed"]);
});

async function analyzeWithClangSources(t, files, units, changed) {
  const root = fixture(t);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const sources = Object.entries(files).map(([file, source]) => ({ file, source }));
  return analyzeNative(root, sources, units, undefined, { host: {}, changed: new Set(changed) });
}

test("real clang: files a unit reads outside the extension table get the policy rules", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const pragmas = '#pragma clang diagnostic ignored "-Wdeprecated-declarations"\n#pragma clang diagnostic ignored "-Wformat-security"\n';
  const unit = include => `${include}\n#include <cstdio>\n#include <cstring>\nvoid h(char *d, const char *s, const char *user) { auto copy = &std::strcpy; copy(d, s); std::printf(user); }\n`;
  const units = [{ file: "src/q.cpp", standard: "c++20" }];
  const txt = await scanWithClang(t, { "src/quiet.txt": pragmas, "src/q.cpp": unit('#include "quiet.txt"') }, units, ["src/q.cpp"]);
  assert.deepEqual(txt.findings, ["native.analysis-suppression@src/quiet.txt:1", "native.analysis-suppression@src/quiet.txt:2"]);
  assert.deepEqual(txt.checks, ["src/q.cpp:failed"]);
  // The compiler resolves the include, so naming it through a macro changes nothing.
  const named = await scanWithClang(t, { "src/quiet": pragmas, "src/q.cpp": unit('#define QUIET "quiet"\n#include QUIET') }, units, ["src/q.cpp"]);
  assert.deepEqual(named.findings, ["native.analysis-suppression@src/quiet:1", "native.analysis-suppression@src/quiet:2"]);
  // clang writes a tab or a Unicode space in a name raw: it is part of the name.
  for (const name of ["q\t/etc", "\u00a0/etc", "\v/etc"]) {
    const spaced = await scanWithClang(t, { [`src/${name}`]: pragmas, "src/q/keep.txt": "x\n", "src/q.cpp": unit(`#include "${name}"`) },
      units, ["src/q.cpp"]);
    assert.deepEqual(spaced.findings, [`native.analysis-suppression@src/${name}:1`, `native.analysis-suppression@src/${name}:2`], name);
  }
  // A listed file Git ignores is not read, as for any listed name.
  const ignored = await scanWithClang(t, { ".gitignore": "*.txt\n", "src/quiet.txt": `${pragmas}static int body(void) { return 0; }\n`,
    "src/u.c": '#include "quiet.txt"\nint main(void) { return body(); }\n' }, [{ file: "src/u.c", standard: "c17" }], ["src/u.c"]);
  assert.deepEqual([ignored.status, ignored.findings, ignored.checks], ["passed", [], ["src/u.c:passed"]]);
  if (process.platform !== "win32") {
    // A repository path that holds a backslash fails the scan closed once a unit is
    // compiled, in both scopes, whether or not the compiler read it: clang lists such a name
    // with a slash there (`src/a\\b.txt` as `src/a/b.txt`), so a listed name can stand for
    // another file (a decoy `src/a/b.txt`, which alone had been read) or for none
    // (`a\\q/../data.txt` listed as `a/q/../data.txt`; `src/a\\..\\x.txt` as `src/a/../x.txt`).
    const c17 = file => [{ file, standard: "c17" }];
    const body = "static int body(void) { return 0; }\n", main = '#include "a\\b.txt"\nint main(void) { return body(); }\n';
    const backslashed = {
      read: [{ "src/a\\b.txt": `${pragmas}${body}`, "src/u.c": main }, c17("src/u.c")],
      decoyed: [{ "src/a\\b.txt": `${pragmas}${body}`, "src/a/b.txt": body, "src/u.c": main }, c17("src/u.c")],
      unread: [{ "notes\\a.txt": "x\n", "src/u.c": "int main(void) { return 0; }\n" }, c17("src/u.c")],
      climbing: [{ "a\\q/t.c": '#include "../data.txt"\nint main(void) { return body(); }\n', "data.txt": body }, c17("a\\q/t.c")],
      dotted: [{ "src/a\\..\\x.txt": body, "src/u.c": '#include "a\\..\\x.txt"\nint main(void) { return body(); }\n' }, c17("src/u.c")],
    };
    for (const [shape, [files, shapeUnits]] of Object.entries(backslashed)) {
      for (const changed of [[shapeUnits[0].file], undefined]) {
        const result = await scanWithClang(t, files, shapeUnits, changed);
        assert.deepEqual([result.status, result.checks], ["error", []], `${shape} ${changed ? "changed" : "repository"}`);
      }
    }
    // In changed scope a changed path that holds a backslash fails closed too, once units
    // are configured, with no unit compiled: it may be a fragment or an included file that
    // cannot be matched reliably. Without a native pass, or without units, such paths
    // change nothing.
    const listed = { "docs\\a.txt": "x\n", "src/u.c": "int main(void) { return 0; }\n" };
    assert.equal((await scanWithClang(t, listed, c17("src/u.c"), ["docs\\a.txt"])).status, "error");
    assert.deepEqual(Object.values(await scanWithClang(t, listed, c17("src/u.c"), [])).slice(0, 3), ["passed", [], []]);
    for (const changed of [["docs\\a.txt"], undefined]) {
      assert.deepEqual(Object.values(await scanWithClang(t, { "docs\\a.txt": "x\n", "README": "x\n" }, [], changed)).slice(0, 3), ["passed", [], []]);
    }
    // A `..` after a link climbs from the link's target, as for the compiler, not from where
    // the link stands (`src/link/../quiet.txt` had been read as the `src/quiet.txt` beside it).
    const linked = await scanWithClang(t, { "deep/dir/keep.txt": "x\n", "deep/quiet.txt": pragmas, "src/quiet.txt": "int decoy;\n",
      "src/u.c": '#include "link/../quiet.txt"\nint main(void) { return 0; }\n' }, [{ file: "src/u.c", standard: "c17" }], ["src/u.c"],
    { "src/link": "../deep/dir" });
    assert.deepEqual(linked.findings, ["native.analysis-suppression@deep/quiet.txt:1", "native.analysis-suppression@deep/quiet.txt:2"]);
  }
  const system = await scanWithClang(t, { "log.def": "#pragma clang system_header\n#include <cstdio>\ninline void log(const char* m) { std::printf(m); }\n",
    "unit.cpp": '#include "log.def"\nvoid f(const char* user) { log(user); }\n' }, [{ file: "unit.cpp", standard: "c++20" }], ["unit.cpp"]);
  assert.deepEqual(system.findings, ["native.analysis-suppression@log.def:1"]);
});

test("real clang: an uppercase .C or .M unit compiles in the language of its declared standard", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  // Valid C that is not C++ (an implicit conversion from void*), and C++ that is not C.
  const c = "#include <stdlib.h>\n#include <string.h>\nchar *copy_name(const char *name)\n{\n  size_t size = strlen(name) + 1;\n"
    + "  char *copy = malloc(size);\n  if (copy != NULL)\n    memcpy(copy, name, size);\n  return copy;\n}\n";
  const cxx = '#include <string>\nstd::string greet(const std::string &name) { return "hello " + name; }\n';
  // Objective-C without an SDK is verified on Linux only (as for the syntax checks).
  const objectiveC = process.platform === "linux" ? [["src/VIEW.M", "c17", c], ["src/VIEW.M", "c++17", cxx]] : [];
  for (const [file, standard, text] of [["src/NAME.C", "c17", c], ["src/NAME.C", "c++17", cxx], ...objectiveC]) {
    const scanned = await scanWithClang(t, { [file]: text }, [{ file, standard }], [file]);
    assert.deepEqual([scanned.status, scanned.checks], ["passed", [`${file}:passed`]], `${file} ${standard}`);
  }
  // The other language rejects it, so the declared standard chose the language.
  const swapped = await scanWithClang(t, { "src/NAME.C": c }, [{ file: "src/NAME.C", standard: "c++17" }], ["src/NAME.C"]);
  assert.deepEqual(swapped.checks, ["src/NAME.C:failed"]);
});

test("real clang: a changed fragment is analyzed through the units that can see it", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const user = "#include <cstdlib>\n#include <cstring>\nnamespace ops {\n#include \"ops.inc\"\n}\nint main() { int *p = (int*)std::malloc(4); return ops::op(p); }\n";
  const units = [{ file: "src/a.cpp", standard: "c++20" }];
  const broken = await scanWithClang(t, { "src/a.cpp": user, "src/ops.inc": "inline int op(int *p) { std::free(p); return *p; }\n" }, units, ["src/ops.inc"]);
  assert.deepEqual(broken.checks, ["src/ops.inc:failed"]);
  // An X-macro table is valid only inside its user, so it is never compiled alone.
  const table = "enum Color {\n#define COLOR(n, v) n = v,\n#include \"colors.def\"\n#undef COLOR\n};\nint first() { return Red; }\n";
  const xmacro = await scanWithClang(t, { "src/b.cpp": table, "src/colors.def": "COLOR(Red, 1)\nCOLOR(Blue, 3)\n" },
    [{ file: "src/b.cpp", standard: "c++20" }], ["src/colors.def"]);
  assert.deepEqual(xmacro.checks, ["src/colors.def:passed"]);
  // A unit that includes it from another directory, directly or through a header, is found
  // by name; the fragment gets the policy rules where the compiler read it.
  const sibling = user.replace('"ops.inc"', '"../gen/ops.inc"');
  const fragment = "#include <cstdlib>\ninline int op(int *p) { std::free(p); return *p; }\ninline int run(const char *c) { return std::system(c); }\n";
  const across = await scanWithClang(t, { "src/a.cpp": sibling, "gen/ops.inc": fragment }, units, ["gen/ops.inc"]);
  assert.deepEqual([across.checks, across.findings], [["gen/ops.inc:failed"], ["native.command-execution@gen/ops.inc:3"]]);
  // clang reads the GNU #import in C and C++ as well.
  const imported = await scanWithClang(t, { "src/a.cpp": sibling.replace('#include "../gen', '#import "../gen'), "gen/ops.inc": fragment },
    units, ["gen/ops.inc"]);
  assert.deepEqual([imported.checks, imported.findings], [["gen/ops.inc:failed"], ["native.command-execution@gen/ops.inc:3"]]);
  // A changed file outside the extension table is compiled through the units that include
  // it by name; one that no configured unit includes is neither compiled nor scanned.
  const body = await scanWithClang(t, { "src/b.cpp": '#include <cstring>\n#include "body.txt"\nint main() { return 0; }\n',
    "src/body.txt": "inline void copy(char *d, const char *s) { std::strcpy(d, s); }\n", "src/notes.txt": "strcpy(a, b);\n" },
  [{ file: "src/b.cpp", standard: "c++20" }], ["src/body.txt", "src/notes.txt"]);
  assert.deepEqual([body.checks, body.findings], [["src/body.txt:failed"], ["native.unbounded-copy@src/body.txt:1"]]);
  // A name an include directory resolves counts, also in angle brackets; so does a script
  // source a unit includes, which the dependency scan then reads with the native rules.
  const searched = await scanWithClang(t, { "src/b.cpp": '#include <cstring>\n#include <body.txt>\nint main() { return 0; }\n',
    "share/body.txt": "inline void copy(char *d, const char *s) { std::strcpy(d, s); }\n" },
  [{ file: "src/b.cpp", standard: "c++20", includes: ["share"] }], ["share/body.txt"]);
  assert.deepEqual([searched.checks, searched.findings], [["share/body.txt:failed"], ["native.unbounded-copy@share/body.txt:1"]]);
  const script = await scanWithClang(t, { "src/a.c": '#include <stdlib.h>\n#include "body.js"\nint main(void) { return run("x"); }\n',
    "src/body.js": "static int run(const char *c) { return system(c); }\n" }, [{ file: "src/a.c", standard: "c17" }], ["src/body.js"]);
  assert.deepEqual([script.checks, script.findings], [["src/body.js:failed"], ["native.command-execution@src/body.js:1"]]);
  // A script named like a standard header selects no unit that includes that header.
  const version = await scanWithClang(t, { "src/app.cpp": '#include "log.hpp"\nint first(int *v) { if (!v) log_line("none"); return *v; }\n',
    "src/log.hpp": "#pragma once\n#include <version>\n#include <cstdio>\ninline void log_line(const char *t) { std::fputs(t, stderr); }\n",
    "tools/version": "#!/bin/sh\necho 1\n" }, [{ file: "src/app.cpp", standard: "c++20" }], ["tools/version"]);
  assert.deepEqual([version.status, version.checks], ["passed", []]);
  // Nor does another unit's include directory: the unit that includes <version> reads the
  // standard header, so its existing defect does not fail a script-only change (selecting
  // every unit that reaches such a line had pushed a one-file change past the unit limit).
  const crossed = await scanWithClang(t, { "src/app.cpp": '#include <version>\n#include <cstdio>\n'
    + 'int count(const int *values) { if (values == nullptr) std::puts("none"); return values[0]; }\n',
  "tools/gen.cpp": '#include <cstdio>\nint main() { std::puts("gen"); return 0; }\n', "tools/version": "#!/bin/sh\necho 1\n" },
  [{ file: "src/app.cpp", standard: "c++20" }, { file: "tools/gen.cpp", standard: "c++20", includes: ["tools"] }], ["tools/version"]);
  assert.deepEqual([crossed.status, crossed.checks], ["passed", []]);
  const viaHeader = await scanWithClang(t, { "src/a.cpp": user.replace('namespace ops {\n#include "ops.inc"\n}', '#include "ops.hpp"'),
    "include/ops.hpp": 'namespace ops {\n#include "../gen/ops.inc"\n}\n', "gen/ops.inc": fragment },
  [{ file: "src/a.cpp", standard: "c++20", includes: ["include"] }], ["gen/ops.inc"]);
  assert.deepEqual(viaHeader.checks, ["gen/ops.inc:failed"]);
});

test("a changed fragment some source includes needs a configured unit; other .inc files are not C or C++", async (t) => {
  const root = fixture(t);
  const sources = [{ file: "src/a.cpp", source: '#include "../gen/ops.inc"\n' }, { file: "mac/v.mm", source: '#include "../gen/kit.inc"\n' }];
  const required = await analyzeNative(root, sources, [], async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["gen/ops.inc"]) });
  assert.deepEqual(required, [{ rule: "native.configuration-required", status: "error" }]);
  // Only an Objective-C unit includes it: not analyzed, like the unit itself.
  assert.deepEqual(await analyzeNative(root, sources, [], async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["gen/kit.inc"]) }), []);
  assert.deepEqual(unanalyzedPlatformUnits(sources, [], new Set(["gen/kit.inc"])), ["gen/kit.inc"]);
  // A unit that reaches several changed fragments is compiled once.
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.cpp"), '#include "../gen/ops.inc"\n#include "../gen/table.def"\n');
  const both = [{ file: "src/a.cpp", source: '#include "../gen/ops.inc"\n#include "../gen/table.def"\n' }];
  let calls = 0;
  const once = await analyzeNative(root, both, [{ file: "src/a.cpp", standard: "c++20" }],
    async () => { calls++; return { ok: true, exitCode: 0 }; }, { host: {}, changed: new Set(["gen/ops.inc", "gen/table.def"]) });
  assert.deepEqual([once.map(item => item.file), calls], [["gen/ops.inc"], 3]);
  // A changed unit that includes a changed fragment is compiled once, as the unit.
  calls = 0;
  const changedUnit = await analyzeNative(root, both, [{ file: "src/a.cpp", standard: "c++20" }],
    async () => { calls++; return { ok: true, exitCode: 0 }; }, { host: {}, changed: new Set(["src/a.cpp", "gen/ops.inc"]) });
  assert.deepEqual([changedUnit.map(item => item.file), calls], [["src/a.cpp"], 3]);
  // Nothing includes it and no unit sees it: not compiled, and not collected for the rules.
  assert.deepEqual(await analyzeNative(root, sources, [], async () => assert.fail("must not compile"),
    { host: {}, changed: new Set(["web/page.inc"]) }), []);
  // A file outside the extension table that no configured unit includes is left alone.
  assert.deepEqual(await analyzeNative(root, [{ file: "src/a.cpp", source: '#include "body.txt"\n' }], [],
    async () => assert.fail("must not compile"), { host: {}, changed: new Set(["src/body.txt"]) }), []);
  // Only an include line that names that very file counts, never a name alone: a script
  // named like a standard header is not the `<version>` or `"format"` a unit includes, unless
  // an include directory makes it so, as it does for the compiler.
  const headerNamed = [{ file: "src/a.cpp", source: '#include <version>\n#include "format"\n#include <../body.txt>\n' }];
  const compiledFor = async (units, changedPath) => {
    const files = [];
    await analyzeNative(root, headerNamed, units, async (_command, args) => { files.push(args.at(-1)); return { ok: true, exitCode: 0 }; },
      { host: {}, changed: new Set([changedPath]) });
    return files.length;
  };
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tools"), { recursive: true });
  mkdirSync(join(root, "inc/sub"), { recursive: true });
  writeFileSync(join(root, "src/a.cpp"), headerNamed[0].source);
  for (const script of ["tools/version", "tools/format", "src/version"]) {
    assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20" }], script), 0, script);
  }
  assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20", includes: ["tools"] }], "tools/version"), 3);
  assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20" }], "src/format"), 3);
  // A path that climbs out of an include directory names the file it reaches.
  assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20", includes: ["inc/sub"] }], "inc/body.txt"), 3);
  assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20", includes: ["inc/sub"] }], "body.txt"), 0);
  assert.equal(await compiledFor([{ file: "src/a.cpp", standard: "c++20", includes: ["inc/sub"] }], "inc/sub/body.txt"), 0);
  // A line is resolved with the search path of the units that reach it (its own unit, or one
  // that includes its header): another unit's include directory does not make `<version>`
  // or `<format>` name a file there, while the unit's own does, also through a header. With
  // no unit listing them, the names alone match nothing.
  const crossed = fixture(t);
  for (const directory of ["src/sub", "tools", "inc/sub"]) mkdirSync(join(crossed, directory), { recursive: true });
  const crossSources = [{ file: "src/app.cpp", source: '#include <version>\n#include "log.hpp"\n' },
    { file: "src/log.hpp", source: '#include <format>\n#include <../body.txt>\n#include "body.txt"\n#include "conf"\n' },
    { file: "tools/gen.cpp", source: "int main();\n" }, { file: "src/wrap.hpp", source: '#include "log.hpp"\n' },
    { file: "src/other.cpp", source: '#include "wrap.hpp"\n' }, { file: "src/a.hpp", source: '#include "b.hpp"\n#include <cycle.txt>\n' },
    { file: "src/b.hpp", source: '#include "c.hpp"\n' }, { file: "src/c.hpp", source: '#include "a.hpp"\n' },
    { file: "src/u0.cpp", source: '#include "a.hpp"\n' }, { file: "src/u1.cpp", source: '#include "b.hpp"\n' }];
  for (const file of ["src/app.cpp", "tools/gen.cpp", "src/other.cpp", "src/u0.cpp", "src/u1.cpp"]) writeFileSync(join(crossed, file), "int f();\n");
  const unitsFor = async (units, changedPath) => {
    const files = new Set();
    await analyzeNative(crossed, crossSources, units, async (_command, args) => { files.add(relative(crossed, args.at(-1))); return { ok: true, exitCode: 0 }; },
      { host: {}, changed: new Set([changedPath]) });
    return [...files];
  };
  const app = { file: "src/app.cpp", standard: "c++20" }, gen = { file: "tools/gen.cpp", standard: "c++20", includes: ["tools", "inc/sub"] };
  for (const changedPath of ["tools/version", "tools/format", "tools/conf", "inc/body.txt"]) {
    assert.deepEqual(await unitsFor([app, gen], changedPath), [], changedPath);
    assert.deepEqual(await unitsFor([{ ...app, includes: ["tools", "inc/sub"] }, gen], changedPath), ["src/app.cpp"], changedPath);
    assert.deepEqual(await unitsFor([app, { ...gen, includes: [] }], changedPath), [], changedPath);
  }
  // Through a header that includes the header with the line: only the unit that lists `tools`.
  const other = { file: "src/other.cpp", standard: "c++20", includes: ["tools"] };
  assert.deepEqual(await unitsFor([app, gen, other], "tools/format"), ["src/other.cpp"]);
  assert.deepEqual(await unitsFor([app, gen, other], "tools/version"), []);
  // Headers that include each other reach the same lines, whichever a unit includes.
  const ring = ["src/u0.cpp", "src/u1.cpp"].map(file => ({ file, standard: "c++20", includes: ["tools"] }));
  assert.deepEqual(await unitsFor([...ring, gen], "tools/cycle.txt"), ["src/u0.cpp", "src/u1.cpp"]);
  // A path that climbs from a directory elsewhere reaches another file.
  assert.deepEqual(await unitsFor([{ ...app, includes: ["src/sub"] }, { ...gen, includes: ["tools"] }], "inc/body.txt"), []);
  assert.deepEqual(await unitsFor([{ ...app, includes: ["src/sub"] }, { ...gen, includes: ["tools"] }], "src/body.txt"), ["src/app.cpp"]);
  // A quoted path relative to the line's own file names it for every unit that reaches it.
  assert.deepEqual(await unitsFor([app, gen], "src/body.txt"), ["src/app.cpp"]);
  // A unit that several changed files select is compiled once, under the first; another
  // directory's search of the same line still selects its own units.
  const compiledUnder = async (units, changedPaths) => (await analyzeNative(crossed, crossSources, units, async () => ({ ok: true, exitCode: 0 }),
    { host: {}, changed: new Set(changedPaths) })).map(item => item.file);
  assert.deepEqual(await compiledUnder([app, gen], ["src/body.txt", "src/conf"]), ["src/body.txt"]);
  const keyed = fixture(t);
  for (const directory of ["d0", "d1", "src"]) mkdirSync(join(keyed, directory));
  for (const file of ["src/u0.c", "src/u1.c"]) writeFileSync(join(keyed, file), "int x;\n");
  const compiled = [];
  const keyedRuns = await analyzeNative(keyed, [{ file: "src/h.h", source: "#include <t.txt>\n" }, { file: "src/u0.c", source: '#include "h.h"\n' },
    { file: "src/u1.c", source: '#include "h.h"\n' }], [0, 1].map(index => ({ file: `src/u${index}.c`, standard: "c17", includes: [`d${index}`] })),
  async (_command, args) => { compiled.push(relative(keyed, args.at(-1))); return { ok: true, exitCode: 0 }; }, { host: {}, changed: new Set(["d0/t.txt", "d1/t.txt"]) });
  assert.deepEqual([keyedRuns.map(item => item.file), [...new Set(compiled)]], [["d0/t.txt", "d1/t.txt"], ["src/u0.c", "src/u1.c"]]);
  // Two lines of one header, each searched in another unit's directory, select each unit
  // under its own file.
  compiled.length = 0;
  const twoLines = await analyzeNative(keyed, [{ file: "src/h.h", source: "#include <a.txt>\n#include <b.txt>\n" }, { file: "src/u0.c", source: '#include "h.h"\n' },
    { file: "src/u1.c", source: '#include "h.h"\n' }], [0, 1].map(index => ({ file: `src/u${index}.c`, standard: "c17", includes: [`d${index}`] })),
  async (_command, args) => { compiled.push(relative(keyed, args.at(-1))); return { ok: true, exitCode: 0 }; }, { host: {}, changed: new Set(["d1/b.txt", "d0/a.txt"]) });
  assert.deepEqual([twoLines.map(item => item.file), [...new Set(compiled)]], [["d1/b.txt", "d0/a.txt"], ["src/u1.c", "src/u0.c"]]);
  // The lines that spell one rest with several climbs are matched by the range of those
  // climbs: `<t.txt>` names `d0/sub/t.txt`, and `<../t.txt>` names `d0/t.txt`.
  mkdirSync(join(keyed, "d0/sub"));
  const ranged = async changedPaths => (await analyzeNative(keyed, [{ file: "src/h.h", source: "#include <t.txt>\n#include <../t.txt>\n" },
    { file: "src/u0.c", source: '#include "h.h"\n' }], [{ file: "src/u0.c", standard: "c17", includes: ["d0/sub"] }],
  async () => ({ ok: true, exitCode: 0 }), { host: {}, changed: new Set(changedPaths) })).map(item => item.file);
  assert.deepEqual([await ranged(["d0/sub/t.txt"]), await ranged(["d0/t.txt"]), await ranged(["t.txt", "d0/sub/sub/t.txt"])],
    [["d0/sub/t.txt"], ["d0/t.txt"], []]);
  // Directories listed at several levels below the file's directory: a line names the file
  // through the directory at its own climb, whatever else the units list above or below
  // that level, and a unit is selected only when it lists such a directory itself.
  const levelled = fixture(t);
  for (const directory of ["src", "inc/sub/deep", "a/x/y/z"]) mkdirSync(join(levelled, directory), { recursive: true });
  for (const file of ["src/app.c", "src/gen.c"]) writeFileSync(join(levelled, file), "int x;\n");
  const levelledUnits = async (lines, includes, changedPaths, genIncludes = [], genLine = "int y;\n") => {
    const files = [];
    await analyzeNative(levelled, [{ file: "src/app.c", source: '#include "h.h"\n' }, { file: "src/h.h", source: lines },
      { file: "src/gen.c", source: genLine }], [{ file: "src/app.c", standard: "c17", includes }, { file: "src/gen.c", standard: "c17", includes: genIncludes }],
    async (_command, args) => { files.push(relative(levelled, args.at(-1))); return { ok: true, exitCode: 0 }; },
    { host: {}, changed: new Set(changedPaths) });
    return [...new Set(files)];
  };
  assert.deepEqual(await levelledUnits("#include <../body.txt>\n", ["inc", "inc/sub"], ["inc/body.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits("#include <body.txt>\n", ["inc", "inc/sub"], ["inc/body.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits("#include <../../../t.txt>\n", ["a/x", "a/x/y/z"], ["a/t.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits("#include <../body.txt>\n", ["inc/sub", "inc/sub/deep"], ["inc/body.txt"]), ["src/app.c"]);
  // The repository root is such a directory too: listed itself, or climbed to.
  assert.deepEqual(await levelledUnits("#include <body.txt>\n", ["."], ["body.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits("#include <../body.txt>\n", ["src"], ["body.txt"]), ["src/app.c"]);
  // Another unit's directory at the line's level does not admit a unit that lists only
  // another level: `app` reads `inc/../body.txt` or `inc/sub/body.txt`, not `inc/body.txt`.
  assert.deepEqual(await levelledUnits("#include <../body.txt>\n", ["inc"], ["inc/body.txt"], ["inc/sub"]), []);
  assert.deepEqual(await levelledUnits("#include <body.txt>\n", ["inc/sub"], ["inc/body.txt"], ["inc"]), []);
  // A line whose climb no unit lists a directory for names nothing, even for a unit that
  // another changed file admits: `app` reads `inc/../a.txt`, and only `gen` reaches `<b.txt>`.
  assert.deepEqual(await levelledUnits("#include <../a.txt>\n", ["inc"], ["inc/a.txt", "inc/b.txt"], ["inc"], "#include <b.txt>\n"), ["src/gen.c"]);
  // Two files found under one directory at different climbs admit the units of both levels,
  // in either order.
  const climbed = ["#include <a.txt>\n#include <../b.txt>\n", ["inc"]];
  for (const order of [["inc/a.txt", "inc/b.txt"], ["inc/b.txt", "inc/a.txt"]]) {
    assert.deepEqual((await levelledUnits(...climbed, order, ["inc/sub"], '#include "h.h"\n')).sort(), ["src/app.c", "src/gen.c"], order.join());
  }
  // A unit is reported under the first file whose lines it reaches, not under an earlier
  // file found under its directory that it does not reach.
  const reported = await analyzeNative(levelled, [{ file: "src/app.c", source: '#include "h.h"\n' }, { file: "src/h.h", source: "#include <b.txt>\n" },
    { file: "src/gen.c", source: '#include "g.h"\n' }, { file: "src/g.h", source: "#include <a.txt>\n" }],
  [{ file: "src/app.c", standard: "c17", includes: ["inc"] }, { file: "src/gen.c", standard: "c17", includes: ["inc"] }],
  async () => ({ ok: true, exitCode: 0 }), { host: {}, changed: new Set(["inc/a.txt", "inc/b.txt"]) });
  assert.deepEqual(reported.map(item => item.file), ["inc/a.txt", "inc/b.txt"]);
  // A quoted path climbs from its own file's directory, never above the repository root.
  assert.deepEqual(await levelledUnits('#include "../inc/q.txt"\n', [], ["inc/q.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits('#include "../../x.txt"\n', [], ["x.txt"]), []);
  // A quoted name holding `>` ends at its `"`, an angled one holding `"` at its `>`.
  assert.deepEqual(await levelledUnits('#include "c>d.txt"\n', [], ["src/c>d.txt"]), ["src/app.c"]);
  assert.deepEqual(await levelledUnits('#include <e"f.txt>\n', ["src"], ['src/e"f.txt']), ["src/app.c"]);
  // A backslash in an include line or an include directory is read both as part of a name
  // and as a separator (as on Windows), which only adds units. A changed path that holds one
  // fails closed while units are configured: clang lists such a name with a slash there.
  assert.deepEqual(await levelledUnits('#include "a\\b.txt"\n', [], ["src/a/b.txt"]), ["src/app.c"]);
  await assert.rejects(levelledUnits('#include "a\\b.txt"\n', [], ["src/a\\b.txt"]), /backslash in a changed path/);
  if (process.platform !== "win32") {
    mkdirSync(join(levelled, "inc\\sub"));
    assert.deepEqual(await levelledUnits("#include <body.txt>\n", ["inc\\sub"], ["inc/sub/body.txt"]), ["src/app.c"]);
    await assert.rejects(levelledUnits("#include <body.txt>\n", ["inc\\sub"], ["inc\\sub/body.txt"]), /backslash in a changed path/);
    // A quoted path climbs out of a directory whose name holds a backslash by one level, as
    // the compiler does on POSIX (`a\q/../data.txt` is `data.txt`), so the unit there is
    // compiled for a change to `data.txt`, and the scan then fails closed on its path.
    mkdirSync(join(levelled, "a\\q"));
    writeFileSync(join(levelled, "a\\q/t.c"), "int x;\n");
    const compiled = [];
    await assert.rejects(analyzeNative(levelled, [{ file: "a\\q/t.c", source: '#include "../data.txt"\n' }], [{ file: "a\\q/t.c", standard: "c17" }],
      async (_command, args) => { compiled.push(relative(levelled, args.at(-1))); return { ok: true, exitCode: 0 }; }, { host: {}, changed: new Set(["data.txt"]) }),
    /backslash in a repository path/);
    assert.deepEqual([...new Set(compiled)], ["a\\q/t.c"]);
  }
  // A line that names another unit's file selects only the units that list its directory,
  // so a one-file change stays under the unit limit: 257 boards each list their own
  // directory and include a shared header that spells `<board_pins.x>`, and 300 units that
  // include `<version>` while one other unit lists `tools` (each was a unit limit error
  // when every unit that reaches the line was selected).
  const boards = fixture(t);
  for (const directory of ["hal/include/hal", "boards/b0", "tools"]) mkdirSync(join(boards, directory), { recursive: true });
  writeFileSync(join(boards, "boards/b0/board.cpp"), "int x;\n");
  const boardUnits = Array.from({ length: 257 }, (_, index) => ({ file: `boards/b${index}/board.cpp`, standard: "c++20",
    includes: ["hal/include", `boards/b${index}`] }));
  const boardSources = [{ file: "hal/include/hal/pins.h", source: "enum pin {\n#include <board_pins.x>\n};\n" },
    ...boardUnits.map(({ file }) => ({ file, source: "#include <hal/pins.h>\n" }))];
  const boardFiles = [];
  await analyzeNative(boards, boardSources, boardUnits, async (_command, args) => { boardFiles.push(relative(boards, args.at(-1))); return { ok: true, exitCode: 0 }; },
    { host: {}, changed: new Set(["boards/b0/board_pins.x"]) });
  assert.deepEqual([...new Set(boardFiles)], ["boards/b0/board.cpp"]);
  const versionUnits = [...Array.from({ length: 300 }, (_, index) => ({ file: `src/u${index}.cpp`, standard: "c++20" })),
    { file: "tools/gen.cpp", standard: "c++20", includes: ["tools"] }];
  assert.deepEqual(await analyzeNative(boards, [...versionUnits.slice(0, -1).map(({ file }) => ({ file, source: "#include <version>\n" })),
    { file: "tools/gen.cpp", source: "int main();\n" }], versionUnits, async () => assert.fail("must not compile"),
  { host: {}, changed: new Set(["tools/version"]) }), []);
  // A changed fragment selects every unit that includes its name while they fit the unit
  // limit; past it, only the units that see it by directory or whose compiler can read that
  // very fragment through a line they reach: each of 100 libraries' public header includes
  // its own generated `ops.def`, and a change to one of them selected all 300 units that
  // include any of those headers (a unit limit error).
  const libraries = fixture(t);
  const libraryUnits = Array.from({ length: 300 }, (_, index) => ({ file: `libs/l${index % 100}/u${index}.cpp`, standard: "c++20",
    includes: [`libs/l${index % 100}/include`] }));
  for (const { file, includes } of libraryUnits) {
    mkdirSync(join(libraries, includes[0]), { recursive: true });
    writeFileSync(join(libraries, file), "int x;\n");
  }
  const librarySources = [...libraryUnits.map(({ file }, index) => ({ file, source: `#include <l${index % 100}/api.h>\n` })),
    ...Array.from({ length: 100 }, (_, index) => ({ file: `libs/l${index}/include/l${index}/api.h`, source: `#include <l${index}/gen/ops.def>\n` }))];
  const libraryFiles = async (units, alsoChanged = []) => {
    const files = new Set();
    await analyzeNative(libraries, librarySources, units, async (_command, args) => { files.add(relative(libraries, args.at(-1))); return { ok: true, exitCode: 0 }; },
      { host: {}, changed: new Set([...alsoChanged, "libs/l0/include/l0/gen/ops.def"]) });
    return [...files];
  };
  assert.deepEqual(await libraryFiles(libraryUnits), ["libs/l0/u0.cpp", "libs/l0/u100.cpp", "libs/l0/u200.cpp"]);
  assert.deepEqual(await libraryFiles(libraryUnits.slice(0, 257)), ["libs/l0/u0.cpp", "libs/l0/u100.cpp", "libs/l0/u200.cpp"]);
  assert.equal((await libraryFiles(libraryUnits.slice(0, 256))).length, 256);
  // What the limit leaves counts the changed units and header jobs too.
  mkdirSync(join(libraries, "libs/l1/include/l1"));
  writeFileSync(join(libraries, "libs/l1/include/l1/api.h"), "int api;\n");
  assert.deepEqual(await libraryFiles(libraryUnits.slice(0, 256), ["libs/l1/u1.cpp", "libs/l1/include/l1/api.h"]),
    ["libs/l1/u1.cpp", "libs/l1/include/l1/api.h", "libs/l0/u0.cpp", "libs/l0/u100.cpp", "libs/l0/u200.cpp"]);
  // So do the units the other changed files select: the 200 units that include the
  // fragment's name fit alone, but not beside the 60 that a changed `inc/y.txt` selects, so
  // the fragment keeps only the units that see it by directory or name it by path.
  const others = Array.from({ length: 60 }, (_, index) => ({ file: `src/a${index}.cpp`, standard: "c++20", includes: ["inc"] }));
  mkdirSync(join(libraries, "src"));
  mkdirSync(join(libraries, "inc"));
  for (const { file } of others) writeFileSync(join(libraries, file), "int x;\n");
  const besideOthers = async (alsoChanged) => {
    const files = new Set();
    await analyzeNative(libraries, [...librarySources, ...others.map(({ file }) => ({ file, source: "#include <y.txt>\n" }))],
      [...libraryUnits.slice(0, 200), ...others], async (_command, args) => { files.add(relative(libraries, args.at(-1))); return { ok: true, exitCode: 0 }; },
      { host: {}, changed: new Set([...alsoChanged, "libs/l0/include/l0/gen/ops.def"]) });
    return [...files];
  };
  assert.equal((await besideOthers([])).length, 200);
  const narrowed = await besideOthers(["inc/y.txt"]);
  assert.deepEqual([narrowed.length, narrowed.filter(file => file.startsWith("libs/"))], [62, ["libs/l0/u0.cpp", "libs/l0/u100.cpp"]]);
  // Linear however many include directories resolve a line: a file 1,000 directories deep,
  // a unit listing each level, and every level's spelling at the end of a 20,000-header
  // chain that every unit reaches (one search per match took 18 s).
  const levels = Array.from({ length: 1000 }, (_, level) => "d/".repeat(level + 1).slice(0, -1));
  const deepFile = `${levels.at(-1)}/x.txt`;
  const chain = Array.from({ length: 20_000 }, (_, index) => ({ file: `h/h${index}.h`,
    source: index < 19_999 ? `#include "h${index + 1}.h"\n` : levels.map(level => `#include <${deepFile.slice(level.length + 1)}>\n`).join("") }));
  const deepUnits = levels.map((level, index) => ({ file: `mac/u${index}.mm`, standard: "c++20", includes: [level] }));
  const started = performance.now();
  unanalyzedPlatformUnits([...deepUnits.map(({ file }) => ({ file, source: '#include "../h/h0.h"\n' })), ...chain], deepUnits, new Set([deepFile]));
  assert.ok(performance.now() - started < 6_000);
  // Linear in the changed files, the units and the include lines together: each changed
  // file, header or fragment costs its own path and what it reaches, never a pass over every
  // unit or over a unit's every include line (each of these took 7 to 20 s, the fragments
  // and headers several minutes at 8,000).
  const timed = (label, sources, units, changed, bound = 3_000) => {
    const begun = performance.now();
    assert.deepEqual(unanalyzedPlatformUnits(sources, units, changed), [], label);
    assert.ok(performance.now() - begun < bound, `${label}: ${performance.now() - begun} ms`);
  };
  const many = (count, make) => Array.from({ length: count }, (_, index) => make(index));
  const texts = many(30_000, index => `data/t${index}.txt`);
  timed("changed files one unit includes", [{ file: "src/u.c", source: texts.map(file => `#include "../${file}"\n`).join("") }],
    [{ file: "src/u.c", standard: "c17" }], new Set(texts));
  // A line of one unit meets the units listing its directory from that one unit's side.
  const listing = many(16_000, index => ({ file: `src/u${index}.c`, standard: "c17", includes: ["inc"] }));
  const listed = many(16_000, index => `inc/t${index}.txt`);
  timed("changed files every unit's directory names", listing.map(({ file }, index) => ({ file,
    source: index ? "int x;\n" : listed.map(file => `#include <${file.slice(4)}>\n`).join("") })), listing, new Set(listed), 1_500);
  const seeing = many(4_000, index => ({ file: `src/u${index}.c`, standard: "c17", includes: ["inc"] }));
  const seen = many(4_000, index => ({ file: `inc/h${index}.h`, source: "int h(void);\n" }));
  timed("changed headers every unit sees", [...seeing.map(({ file }) => ({ file, source: "int x;\n" })), ...seen], seeing,
    new Set(seen.map(({ file }) => file)));
  timed("changed fragments every unit sees", seeing.map(({ file }) => ({ file, source: "int x;\n" })), seeing,
    new Set(many(4_000, index => `inc/f${index}.inc`)));
  const tail = many(6_000, index => `t/t${index}.txt`), headers = many(6_000, index => ({ file: `h/h${index}.h`,
    source: index < 5_999 ? `#include "h${index + 1}.h"\n` : tail.map(file => `#include "../${file}"\n`).join("") }));
  timed("changed files named at the end of a header chain", [...headers, { file: "src/u.c", source: '#include "../h/h0.h"\n' }],
    [{ file: "src/u.c", standard: "c17" }], new Set(tail));
  // The same line, `<t.txt>` at the end of the chain, names each unit's own `d<i>/t.txt`:
  // the first file selects every unit that reaches the line, in one walk up the chain.
  const own = many(12_000, index => ({ file: `src/u${index}.c`, standard: "c17", includes: [`d${index}`] }));
  timed("changed files each unit's directory names at the end of a header chain",
    [...headers.slice(0, -1), { file: "h/h5999.h", source: "#include <t.txt>\n" }, ...own.map(({ file }) => ({ file, source: '#include "../h/h0.h"\n' }))],
    own, new Set(own.map((_, index) => `d${index}/t.txt`)), 1_500);
  // Every unit lists `inc`, and each changed `inc/t<i>.txt` is named in a header only `u<i>`
  // includes: each line meets the one unit that reaches it, not every unit listing `inc`.
  const sharing = many(14_000, index => ({ file: `src/u${index}.c`, standard: "c17", includes: ["inc"] }));
  timed("changed files every unit's directory names in headers one unit each includes",
    [...sharing.map(({ file }, index) => ({ file, source: `#include "h${index}.h"\n` })),
      ...sharing.map((_, index) => ({ file: `src/h${index}.h`, source: `#include <t${index}.txt>\n` }))],
    sharing, new Set(sharing.map((_, index) => `inc/t${index}.txt`)), 1_500);
  const sameName = many(20_000, index => ({ file: `d${index}/c.h`, source: '#include "c.h"\nint y;\n' }));
  timed("changed headers of one name", [...sameName, { file: "src/u.c", source: "int x;\n" }], [{ file: "src/u.c", standard: "c17" }],
    new Set(sameName.map(({ file }) => file)));
  // Units that each list 30,000 directories, each holding a changed file a line of one unit
  // names: each file is checked against the listed directories once along its path, not
  // against a unit's every directory (2.7 s at 34,000).
  const listedDirectories = many(30_000, index => `i/${29_999 - index}`);
  const wide = ["u", "v", "w"].map(name => ({ file: `src/${name}.c`, standard: "c17", includes: listedDirectories }));
  timed("changed files in the many directories each unit lists", wide.map(({ file }, index) => ({ file, source: index ? "int y;\n" : '#include "t.txt"\n' })),
    wide, new Set(many(30_000, index => `i/${index}/t.txt`)), 1_500);
  // The same where the line's unit lists 40,000 other directories: no check reads them all.
  const apart = [{ file: "src/u.c", standard: "c17", includes: many(40_000, index => `a/${index}`) },
    ...["v", "w"].map(name => ({ file: `src/${name}.c`, standard: "c17", includes: many(20_000, index => `b/${index}`) }))];
  timed("changed files in directories other units list", apart.map(({ file }, index) => ({ file, source: index ? "int y;\n" : '#include "t.txt"\n' })),
    apart, new Set(many(20_000, index => `b/${index}/t.txt`)), 1_500);
  // Each header of a 20,000-header chain names a changed file, or a changed fragment: one
  // walk up the chain for them all, not one per header (19 s and 25 s at 8,000).
  const linked = [{ file: "src/u.c", source: '#include "h0.h"\n' }, ...many(20_000, index => ({ file: `src/h${index}.h`,
    source: `#include "h${index + 1}.h"\n#include "t${index}.txt"\n#include "f${index}.inc"\n` }))];
  const linkedTexts = new Set(many(20_000, index => `src/t${index}.txt`));
  timed("changed files named along a header chain", linked, [{ file: "src/u.c", standard: "c17" }], linkedTexts, 1_500);
  timed("changed fragments named along a header chain", linked, [{ file: "src/u.c", standard: "c17" }], new Set(many(20_000, index => `src/f${index}.inc`)), 1_500);
  // 8,000 units include one header that names 8,000 changed files in a directory they all
  // list: the header is walked up once, not once per file (9 s).
  const shared = many(8_000, index => ({ file: `src/s${index}.c`, standard: "c17", includes: ["inc"] }));
  timed("changed files one shared header names", [...shared.map(({ file }) => ({ file, source: '#include "all.h"\n' })),
    { file: "src/all.h", source: many(8_000, index => `#include "t${index}.txt"\n`).join("") }], shared, new Set(many(8_000, index => `inc/t${index}.txt`)));
  // 8,000 headers hold the same line `<t.txt>`, which names a changed file in each of 8,000
  // directories one unit lists: the line's headers are walked up once in all, not once per
  // directory.
  const fanned = many(8_000, index => ({ file: `src/f${index}.c`, standard: "c17", includes: index ? [] : many(8_000, at => `d${at}`) }));
  timed("changed files one line of many headers names in many directories", [...fanned.map(({ file }, index) => ({ file, source: `#include "g${index}.h"\n` })),
    ...many(8_000, index => ({ file: `src/g${index}.h`, source: "#include <t.txt>\n" }))], fanned, new Set(many(8_000, index => `d${index}/t.txt`)));
  // Each header of a 6,000-header chain names a changed file in its own directory of the
  // unit; each header of the 20,000-header chain above quotes its own changed file in the
  // directory the unit lists; one in 20 headers of a layered graph of 10,000 headers does so
  // in the directory 20 units list: one walk up for all of them, not one per directory or per
  // header found in two searches (each of these failed on a lookup bound).
  const climbing = [{ file: "src/u.c", source: '#include "h0.h"\n' }, ...many(6_000, index => ({ file: `src/h${index}.h`,
    source: `#include "h${index + 1}.h"\n#include <t${index}.txt>\n` }))];
  timed("changed files each in another directory along a header chain", climbing,
    [{ file: "src/u.c", standard: "c17", includes: many(6_000, index => `d${index}`) }], new Set(many(6_000, index => `d${index}/t${index}.txt`)));
  timed("changed files named along a header chain in the directory the unit lists", linked, [{ file: "src/u.c", standard: "c17", includes: ["src"] }],
    linkedTexts, 1_500);
  const layered = many(10_000, index => {
    const layer = Math.floor(index / 100), at = index % 100;
    const below = layer < 99 ? many(3, k => `#include "h${layer + 1}_${(at * 7 + k * 31 + layer) % 100}.h"\n`).join("") : "";
    return { file: `src/h${layer}_${at}.h`, source: below + (at % 20 ? "" : `#include "t${layer}_${at}.txt"\n`) + "int x;\n" };
  });
  const layerUnits = many(20, index => ({ file: `src/u${index}.c`, standard: "c17", includes: ["src"] }));
  timed("changed files named across a layered header graph", [...layered,
    ...layerUnits.map(({ file }, index) => ({ file, source: many(5, k => `#include "h0_${(index * 5 + k) % 100}.h"\n`).join("") }))],
  layerUnits, new Set(layered.filter(({ source }) => source.includes(".txt")).map(({ file }) => file.replace(/h(\d+_\d+)\.h$/, "t$1.txt"))), 1_500);
  // One 2 MiB header spells `x.txt` after each of 1,180 climbs, and 29,000 changed `x.txt`
  // lie in directories the unit lists: each file's path costs a constant check per
  // component, however many climbs the spellings hold (2.2 s when every climb was checked).
  const climbs = many(1_180, up => `#include "${"../".repeat(up)}x.txt"\n`).join("");
  const climbDirectories = many(29_000, index => `i/${index}`);
  timed("changed files a header spells after many climbs", [{ file: "src/u.c", source: '#include "h.h"\n' }, { file: "src/h.h", source: climbs }],
    [{ file: "src/u.c", standard: "c17", includes: climbDirectories }], new Set(climbDirectories.map(directory => `${directory}/x.txt`)), 1_500);
  // An include line and an include directory that each climb 60,000 levels are read in one
  // pass (posix.normalize read its result again at each leading `..`: 6.7 s).
  const far = "../".repeat(60_000);
  timed("a long climb", [{ file: "src/u.c", source: '#include "h.h"\n' }, { file: "src/h.h", source: `#include "${far}x.txt"\n` }],
    [{ file: "src/u.c", standard: "c17", includes: [`${far}src`, "src"] }], new Set(["src/x.txt"]), 1_500);
  // A quoted line is resolved from its source's directory, found once per source, and a
  // spelling only as far as the changed paths reach: 2 MiB of distinct quoted names in a
  // directory 1,900 levels deep, with a changed file next to them or a changed header
  // elsewhere (10 s when each line rebuilt its source's path), and 15 headers of 2 MiB that
  // spell distinct ten-component paths, with only a README changed (out of memory when every
  // spelling was kept).
  const twoMiB = line => { const lines = []; for (let index = 0, length = 0; length < 2 * 1024 * 1024 - 64; index++) { lines.push(line(index)); length += lines.at(-1).length; } return lines.join(""); };
  const deepDirectory = many(1_900, () => "a").join("/");
  const deepSources = [{ file: "u.c", source: `#include "${deepDirectory}/x.h"\n` }, { file: "z.h", source: "int z;\n" },
    { file: `${deepDirectory}/x.h`, source: twoMiB(index => `#include "${index.toString(36)}"\n`) }];
  timed("changed files quoted in a deep directory", deepSources, [{ file: "u.c", standard: "c17" }], new Set([`${deepDirectory}/0`]), 1_500);
  timed("a changed header beside quoted names in a deep directory", [...deepSources], [{ file: "u.c", standard: "c17" }], new Set(["z.h"]), 1_500);
  // 10,000 changed files each 200 levels deep, every suffix of one spelled by a header: the
  // changed paths' trees keep an unbranched run of components without a map per component.
  const deepRun = many(199, () => "a").join("/");
  timed("changed files deep in distinct directories", [{ file: "src/u.c", source: '#include "h.h"\n' },
    { file: "src/h.h", source: many(200, depth => `#include <${"a/".repeat(depth)}x.txt>\n`).join("") }],
  [{ file: "src/u.c", standard: "c17", includes: ["."] }], new Set(many(10_000, index => `b${index}/${deepRun}/x.txt`)), 1_500);
  let spelled = 0;
  const spellings = many(15, index => ({ file: `src/h${index}.h`, source: twoMiB(() => `#include "a/b/c/d/e/f/g/h/i/f${(spelled++).toString(36)}.h"\n`) }));
  timed("an unrelated change beside many spellings", [...spellings, { file: "src/u.c", source: "int x;\n" }], [{ file: "src/u.c", standard: "c17" }],
    new Set(["README"]), 1_500);
  const repository = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "ignore" });
  mkdirSync(join(repository, "asm"));
  writeFileSync(join(repository, "page.inc"), '<?php echo sprintf("%s", $x); ?>\n');
  writeFileSync(join(repository, "asm/strings.inc"), Buffer.from("; caf\xe9 strings\n", "latin1"));
  for (const changedPaths of [["page.inc", "asm/strings.inc"], undefined]) {
    const scanned = await scanRepository({ root: repository, changedPaths, nativeHost: {} });
    assert.deepEqual([scanned.status, scanned.findings, scanned.coverage.sourceFiles], ["passed", [], 0]);
  }
});

test("real clang: a header that only looks like Objective-C is analyzed when it compiles as C or C++", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const uaf = "inline int copy(int n) { int* p = new int[4](); delete[] p; return p[n]; }\n";
  const units = [{ file: "src/codec.cpp", standard: "c++20" }];
  for (const marker of ["#import <cstdlib>\n", "#ifdef __OBJC__\n@class NSData;\n#endif\n", "#if 0\n@class X;\n#endif\n"]) {
    const outcome = await analyzeWithClangSources(t, { "src/codec.cpp": "int use() { return 0; }\n", "src/bytes.hpp": `#pragma once\n${marker}${uaf}` },
      units, ["src/bytes.hpp"]);
    assert.deepEqual(outcome.map(item => `${item.rule}:${item.status}`), ["native.clang-analysis:failed"], marker);
  }
  // A header that needs the platform SDK stays an explicit coverage gap.
  const kit = "#pragma once\n#import <ScreenCaptureKit/ScreenCaptureKit.h>\nnamespace mac { SCShareableContent* content(); }\n";
  const scanned = await scanWithClang(t, { "src/codec.cpp": "int use() { return 0; }\n", "src/kit.hpp": kit }, units, ["src/kit.hpp"]);
  assert.deepEqual([scanned.status, scanned.checks, scanned.notAnalyzed], ["passed", [], ["src/kit.hpp"]]);
  // So does one whose own or imported text is Objective-C (an `@` outside literals); a
  // header whose imports resolve is compiled like any other, self-contained or not.
  const objc = { "src/codec.cpp": "int use() { return 0; }\n", "src/Base.h": "#pragma once\n@interface Base\n@end\n",
    "src/Kit.h": '#pragma once\n#import "Base.h"\nstatic inline int kit(void) { return 1; }\n',
    "src/V.h": "#pragma once\nstatic const char *name = \"@V\";\n@class NSView;\n",
    // Its `@` alone decides: this one does not parse as Objective-C either without its SDK.
    "src/W.h": "#pragma once\n#import \"Base.h\"\n@interface W : NSView\n@end\n" };
  const reported = await scanWithClang(t, objc, units, ["src/Kit.h", "src/V.h", "src/W.h"]);
  assert.deepEqual([reported.status, reported.checks, reported.notAnalyzed], ["passed", [], ["src/Kit.h", "src/V.h", "src/W.h"]]);
  const partial = await scanWithClang(t, { "src/codec.cpp": "typedef int Handle;\n#include \"util.hpp\"\nint main() { return 0; }\n",
    "src/util.hpp": "#pragma once\n#import <cstdlib>\ninline int ok(Handle *p) { std::free(p); return *p; }\n" }, units, ["src/util.hpp"]);
  assert.deepEqual([partial.checks, partial.notAnalyzed], [["src/util.hpp:failed"], []]);
  // A probed header's dependency list comes from its diagnostics pass, the second one.
  const listed = await scanWithClang(t, { "src/codec.cpp": "int use() { return 0; }\n",
    "src/log.hpp": '#pragma once\n#import <cstdio>\n#include "quiet.txt"\ninline void log(const char *m) { std::printf(m); }\n',
    "src/quiet.txt": '#pragma clang diagnostic ignored "-Wformat-security"\n' }, units, ["src/log.hpp"]);
  assert.deepEqual([listed.checks, listed.findings], [["src/log.hpp:failed"], ["native.analysis-suppression@src/quiet.txt:1"]]);
});

test("real clang: Objective-C without an `@` in a header is not analyzed; a C defect still fails", { skip: (!clangAvailable() && "clang++ is not installed") || (process.platform !== "linux" && "blocks are C on Apple hosts, and Objective-C support differs by target") }, async (t) => {
  // Objective-C without an `@` (a message send, a block type) does not parse as C or C++
  // even without warnings, and does as Objective-C: not analyzed either. A C header with a
  // defect the warnings catch parses as C, so it fails.
  const types = "#ifndef TYPES_H\n#define TYPES_H\ntypedef int Status;\n#endif\n";
  const cUnits = [{ file: "src/main.c", standard: "c17" }];
  const messages = await scanWithClang(t, { "src/main.c": "int main(void) { return 0; }\n", "src/Types.h": types,
    "src/Ping.h": '#import "Types.h"\nstatic inline Status ping(id target) { return (Status)[target ping]; }\n',
    "src/Callback.h": '#import "Types.h"\ntypedef void (^Completion)(Status status);\n',
    "src/Copy.h": '#import "Types.h"\n#include <string.h>\n#define COPY strcpy\nstatic inline void copy(char *d, const char *s) { COPY(d, s); }\n' },
  cUnits, ["src/Ping.h", "src/Callback.h", "src/Copy.h"]);
  assert.deepEqual([messages.checks, messages.notAnalyzed], [["src/Copy.h:failed"], ["src/Callback.h", "src/Ping.h"]]);
});

test("real clang: a header written for C and C++ is compiled in both languages", { skip: !clangAvailable() && "clang++ is not installed" }, async (t) => {
  const units = [{ file: "src/main.c", standard: "c17" }, { file: "src/run.cpp", standard: "c++20" }];
  const files = { "src/main.c": '#include "api.h"\nint main(void) { return api(); }\n', "src/run.cpp": '#include "api.h"\nint run() { return api(); }\n' };
  const api = "#include <stdlib.h>\nint api(void);\n#ifdef __cplusplus\ninline int api_take(int *p) { free(p); return *p; }\n#endif\n";
  const outcome = await analyzeWithClangSources(t, { ...files, "src/api.h": api }, units, ["src/api.h"]);
  assert.deepEqual(outcome.map(item => item.status), ["passed", "failed"]);
  // A C header with only C++ linkage boilerplate is compiled as C++ only when a C++ file
  // includes it: its C body need not be valid C++ (a conversion from void* is implicit).
  const buf = "#ifndef BUF_H\n#define BUF_H\n#include <stdlib.h>\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n"
    + "static inline char *buf_new(size_t n) { return malloc(n); }\n#ifdef __cplusplus\n}\n#endif\n#endif\n";
  const cFiles = { "src/main.c": '#include "buf.h"\nint main(void) { return 0; }\n', "src/run.cpp": "int run() { return 0; }\n", "src/buf.h": buf };
  assert.deepEqual((await analyzeWithClangSources(t, cFiles, units, ["src/buf.h"])).map(item => item.status), ["passed"]);
  const cxxIncluded = await analyzeWithClangSources(t, { ...cFiles, "src/run.cpp": '#include "buf.h"\nint run() { return 0; }\n' },
    units, ["src/buf.h"]);
  assert.deepEqual(cxxIncluded.map(item => item.status), ["passed", "failed"]);
  // Also when C++ reaches it only through another header.
  const cxxReached = await analyzeWithClangSources(t, { ...cFiles, "src/run.cpp": '#include "wrap.h"\nint run() { return 0; }\n',
    "src/wrap.h": '#pragma once\n#include "buf.h"\n' }, units, ["src/buf.h"]);
  assert.deepEqual(cxxReached.map(item => item.status), ["passed", "failed"]);
  // A definition in a C++ group, or a test of __cplusplus through a definition, gives the
  // body another meaning in C++, so the header is compiled as C++ although no C++ file
  // includes it.
  const cxxDefinition = "#ifndef API_H\n#define API_H\n#ifdef __cplusplus\n#define READ(p) (*(int *)0)\nextern \"C\" {\n#else\n"
    + "#define READ(p) (*(p))\n#endif\nstatic inline int api_get(int *p) { return p ? READ(p) : 0; }\n#ifdef __cplusplus\n}\n#endif\n#endif\n";
  const isCxx = "#ifndef API_H\n#define API_H\n#define IS_CXX __cplusplus\n#if IS_CXX\nstatic inline int api_get(int *p) { (void)p; return *(int *)0; }\n"
    + "#else\nstatic inline int api_get(int *p) { return *p; }\n#endif\n#endif\n";
  // So does a pragma that restores another definition for C++ only.
  const popMacro = "#ifndef API_H\n#define API_H\n#define READ(p) (*(int *)0)\n#pragma push_macro(\"READ\")\n#undef READ\n"
    + "#define READ(p) (*(p))\n#ifdef __cplusplus\n#pragma pop_macro(\"READ\")\nextern \"C\" {\n#endif\n"
    + "static inline int api_get(int *p) { return p ? READ(p) : 0; }\n#ifdef __cplusplus\n}\n#endif\n#endif\n";
  const usedBy = (header, cxx = "int run() { return 0; }\n") => ({ "src/main.c": '#include "api.h"\nint main(void) { int x = 1; return api_get(&x); }\n',
    "src/run.cpp": cxx, "src/api.h": header });
  for (const header of [cxxDefinition, isCxx, popMacro]) {
    assert.deepEqual((await analyzeWithClangSources(t, usedBy(header), units, ["src/api.h"])).map(item => item.status), ["passed", "failed"], header);
  }
  // C++ reads the code C reads less what only C reads: a check only C reads is compiled as
  // C++ only when a C++ file includes the header, as any C header with C++ linkage is.
  const cOnlyCheck = "#ifndef API_H\n#define API_H\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n"
    + "static inline int api_get(int *p) {\n  int *q = (int *)0;\n#ifndef __cplusplus\n  q = p;\n#endif\n  return *q;\n}\n"
    + "#ifdef __cplusplus\n}\n#endif\n#endif\n";
  assert.deepEqual((await analyzeWithClangSources(t, usedBy(cOnlyCheck), units, ["src/api.h"])).map(item => item.status), ["passed"]);
  assert.deepEqual((await analyzeWithClangSources(t, usedBy(cOnlyCheck, '#include "api.h"\nint run() { int x = 1; return api_get(&x); }\n'),
    units, ["src/api.h"])).map(item => item.status), ["passed", "failed"]);
  // A valid C header whose C body is no valid C++ (a conversion from void*) is compiled as C
  // alone when no C++ file includes it, also with a member only C reads (linux/keyctl.h), an
  // empty macro only C defines and uses inside parentheses (X11/Xalloca.h), or a function
  // body split over two groups of one condition.
  const cBody = "static inline int *mk(void) { int *p = malloc(sizeof *p); return p; }\n";
  const wrapped = text => `#ifndef API_H\n#define API_H\n#include <stdlib.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n${text}`
    + "static inline int api_get(int *p) { int *q = mk(); int v = *p; free(q); return v; }\n#ifdef __cplusplus\n}\n#endif\n#endif\n";
  for (const header of [
    wrapped(`struct key_params {\n  union {\n#ifndef __cplusplus\n    int private;\n#endif\n    int priv;\n  };\n};\n${cBody}`),
    wrapped(`#ifndef __cplusplus\n# define NO_ARG\nextern void *legacy_alloc(NO_ARG);\n#endif\n${cBody}`),
    wrapped("#if USE_INLINE\nstatic inline int *mk(void) {\n#else\nstatic inline int *mk(void) { return malloc(sizeof (int)); }\nint *mk_old(void);\n#endif\n"
      + "#if USE_INLINE\n  int *p = malloc(sizeof *p);\n  return p;\n}\n#endif\n"),
  ]) {
    assert.deepEqual((await analyzeWithClangSources(t, usedBy(header), units, ["src/api.h"])).map(item => item.status), ["passed"], header);
  }
  // A lone CR or CR LF ends a directive as LF does: a C header with only C++ linkage is
  // still compiled as C alone.
  for (const end of ["\r\n", "\r"]) {
    const ended = { ...cFiles, "src/buf.h": buf.replaceAll("\n", end) };
    assert.deepEqual((await analyzeWithClangSources(t, ended, units, ["src/buf.h"])).map(item => item.status), ["passed"], JSON.stringify(end));
  }
  // A plain C++ .h that only C++ files include is not compiled as C.
  const vec = "#pragma once\n#include <cstdint>\nstruct Vec { float x, y; float dot(const Vec& o) const { return x * o.x + y * o.y; } };\n";
  const mixed = await analyzeWithClangSources(t, { ...files, "src/run.cpp": '#include "vec.h"\nint run() { return 0; }\n', "src/vec.h": vec },
    units, ["src/vec.h"]);
  assert.deepEqual(mixed.map(item => item.status), ["passed"]);
});
