---
type: feature
title: Praesidium — deterministic security toolset
description: Pre-test source policy, native static analysis, reusable web ingress contracts and the native C/C++ baseline.
service: revisor
domain: review-gate
status: implemented
---

# Praesidium

## RV-PRAESIDIUM-01: Offline source policy and explicit coverage

Praesidium (Latin: protection) is an independently callable CLI shipped with Revisor.
`node src/praesidium/cli.mjs --repo <repository> [--base <ref>]` or installed `praesidium --repo <repository>`
emits one JSON object; exit 0 is the configured checks passing, 1 is findings/failing checks,
2 is an incomplete inspection. It uses no LLM, remote API, new npm dependency or application launch.

The baseline scans Git-tracked and nonignored new C/C++ and JS/TS source files, including tests.
Native sources are one table (`src/praesidium/languages.mjs`) shared by collection, rules and native
analysis: C (`.c`), C++ (`.cc .cpp .cxx .c++`), C or C++ (`.C`), C++20 module units (`.cppm .ixx
.mpp .ccm .cxxm .c++m`), Objective-C (`.m`), Objective-C++ (`.mm`), Objective-C or Objective-C++
(`.M`), headers (`.h .hh .hpp .hxx .h++` plus the template and inline implementation headers
`.inl .ipp .tpp .tcc`), and fragments `.inc .def` (lexed like headers, never compiled alone,
policy-scanned only where an analyzed unit's compiler reads them, not collected as policy sources;
RV-PRAESIDIUM-03). `.c`, `.C`, `.m` and `.M` are told apart by case, and the uppercase `.C` and
`.M` are either language: clang and GCC compile them as C++ and Objective-C++, while MSVC and
DOS-era code compile `.C` as C. A `.C` or `.M` that `praesidium.json` configures as a unit
declares a C or a C++ standard, which sets the language it is compiled in (RV-PRAESIDIUM-03) and
the lexical readings the rules read it in, as the extension does for every other file; an
unconfigured one (or one whose entry names no supported standard) is read in every lexical
reading (C17, C23 and C++), like a header. A `.M` is an Objective-C/C++ unit either way. The
other extensions match in any case (`.CPP` is C++, `.MM` Objective-C++, `.H` a header).

`.m` is also MATLAB, Octave and Mathematica source, so collection (`trackedSources` in `files.mjs`)
leaves out a `.m` whose raw bytes show nothing that could open or supply a C-family body: no `{`,
`<%` or `??<`, no directive (`#`, `%:`, `??=`), no pragma operator (`_Pragma` or `__pragma`, which
can import a module: `_Pragma("clang module import X")`), and not both `@` and the word `import`
(`@import`, which a comment may split). Only the lowercase `.m` is also MATLAB's: a `.M` (above) is
always a source, so like any source it must be UTF-8. Line splices (`\`
or `??/`, optional blanks, then a line end; CR LF and LF CR count as one) are joined first, and the
check runs before UTF-8 decoding. A `{` or `@` byte right after non-ASCII bytes that are not
well-formed UTF-8 (back to the previous ASCII byte) does not count: clang and GCC reject such bytes
outside comments and literals,
and the comment or literal that holds them also holds the next byte, since each ends with an ASCII
byte. The second byte of many Shift_JIS, GBK and Big5
characters is `{` or `@` (`本`, `ボ`, the ideographic space), and the bytes before it are seldom
well-formed UTF-8, so a MATLAB file with comments in those encodings is left out. The non-ASCII
bytes still count as UTF-8 when they follow a line splice, because GCC decodes a character across
one. Such a file can hold no executable Objective-C, so it is neither policy-scanned nor
reported as not analyzed. Any of those marks, even inside a comment, keeps the file Objective-C
(fail closed), and a `.m` that `praesidium.json` configures as a unit always is. A `.m` is read
before the source limits below apply: one left out counts only toward the `.m` read limits, 64 MiB
per file and 256 MiB for all `.m` files, while one kept is a source under the source limits.
Limits: a MATLAB file with a cell array or `%{` block comment (`{`), a `#`, or both a function
handle (`@`) and the word `import` is still read as Objective-C, so a `system(...)` or
`sscanf(..., '%s')` call in it is a finding, and if it is not UTF-8 the inspection is incomplete,
as it is when a legacy-encoded character before a `{` or `@` happens to be well-formed UTF-8; a
`.m` over 64 MiB, or `.m` files over 256 MiB in all, make the inspection incomplete; a `.m` without
those marks whose bodies come from a prefix header or from macros on the build command line
(`-include`, `-D`) is left out, the macro limit below, and so are one that only GCC's
`-finput-charset` (another build flag) would read as Objective-C and one the build compiles as
Objective-C++ (`-x objective-c++`, Xcode's "Compile Sources As"), where a file-scope initializer
runs code without any of those marks.

Only regular files inside the canonical repository boundary are read; malformed UTF-8, missing
files, symlinks escaping the root and size limits fail closed. A collection finds each file's real
path one component at a time, asking the system once per directory, so files deep in one
directory cost their own components, not the whole depth again for each. Limits: 30,000 listed files,
2 MiB per source, 32 MiB aggregate, 4 MiB Git listing; a `.m` is read under its own limits first
(64 MiB per file and 256 MiB in all, above). Submodule content is not traversed.
Rule findings retain only rule/file/line/severity, never source snippets or request values.
Findings are bounded at 200 per source plus a limit marker, and 1000 per report; hitting a cap
remains a failure and coverage reports the incomplete/truncated policy inspection explicitly.

Current policy rejects unbounded C copy/format APIs (`gets`, `strcpy`, `strcat`, `sprintf`,
`vsprintf`, wide-character variants), direct JS dynamic code evaluation, and simple direct
request-to-HTML/shell assignments. These are **syntactic tripwires**, not AST/taint analysis.
Comments and literals are masked; interpolation, aliases, macros, indirect calls, code generation,
complex control flow and unsupported languages can evade them. No findings is not a safety proof.
For native sources the force-included analysis baseline closes the alias/macro/indirect-call gap
for analyzed units (RV-PRAESIDIUM-05).

Native rules, each measured at zero findings across the 2,828 policy sources of ten local LUDIARS
repositories (Odeum's 418 included). Every call rule also takes a parenthesized name,
`(strcpy)(d, s)`, `((strcpy))(d, s)` or `(std::system)(cmd)`: the parentheses only stop a
function-like ban macro, and the call is still direct.

- `native.unbounded-copy`: the C APIs above, their compiler builtins (`__builtin_sprintf`, and the
  `__builtin___sprintf_chk` form that `_FORTIFY_SOURCE` emits), the glibc entry points those lower
  to (`__sprintf_chk`, `__vsprintf_chk`, `__gets_chk` and the other `__*_chk` forms, which take any
  size; the baseline cannot redeclare these reserved names, and a wrapper named `strcpy_chk` is not
  one) and their Win32/CRT spellings (`lstrcpy[AW]`,
  `lstrcat[AW]`, `wsprintf[AW]`, `wvsprintf[AW]`, `_tcscpy`, `_tcscat`, `_mbscpy`, `_mbscat`,
  `_stprintf`, `_swprintf`, `StrCpy[AW]`, `getwd`, `_getws`, `_getts`). `StrCat` is not listed:
  `absl::StrCat` is safe. A `#define` or `#undef` of the name itself (a banned.h-style defense, also
  with form feeds or vertical tabs in the directive) is not a use;
- `native.unbounded-scan`: a scanf-family call, builtins (`__builtin_sscanf`) and glibc's C99 and
  C23 entry points (`__isoc99_sscanf`, `__isoc23_scanf`) included, whose format may write a string
  of any length: a literal format with `%s`, `%S`, `%ls` or `%[` (positional
  `%1$s` included) without a width (and without `*`; `%ms` allocates). glibc also takes a zero width
  (`%0s`) as none and reads the `'` and `I` flags and the `q` modifier (`%'s`, `%Is`, `%qs`), so
  those are unbounded too. The format is read as the compiler reads it: an ordinary literal loses
  its line splices before its escapes are decoded (`"%\x73"` and `"%\` + newline + `s"` are `%s`),
  and a raw string contributes only the text between its delimiter's parentheses (`R"(%)" "s"` is
  `%s`). A format that is not made only of string literals is rejected as well: a macro or variable
  cannot be checked, nor can `R"..."` in C, which has no raw strings (there `R` is a name and may be
  a macro), and neither can a format argument the bounded 256-character walk does not reach. A
  header may be compiled as C, so a raw-string format in any header (`.h`, `.hpp`) is rejected too;
  an ordinary literal states the same bounded format. Clang's `-Wformat` does not check wide
  formats (`L"%0ls"`), so for them this rule is the only check even in analyzed units. The format
  text is read from the source at the masked literal's offsets and is never retained;
- `native.stack-allocation` (`alloca`, `_alloca` and every `__builtin_alloca*` builtin),
  `native.command-execution` (`system`, `_wsystem`, `popen`, `_popen`, `_wpopen`; members and names
  qualified by a namespace other than `std` are different functions, while a keyword or GNU keyword
  operator before `::`, as in `return ::system(cmd)` or `__extension__ ::system(cmd)`, is not a
  namespace) and `native.insecure-temp-name` (`tmpnam`,
  `tempnam`, `mktemp` and their CRT spellings);
- `native.symbol-alias`: a declaration bound to the symbol of a function the call rules above
  reject, which makes every call of the new name a call of that function out of every rule's and
  the baseline's sight: a GNU asm label (`char *cp(char *, const char *) __asm__("strcpy");`), the
  `weakref` or `alias` attribute (`__attribute__((weakref("strcpy")))`), Microsoft's
  `#pragma comment(linker, "/alternatename:cp=strcpy")` and `#pragma redefine_extname cp strcpy`,
  and an asm statement whose text names such a symbol (`__asm__("call strcpy")`). The symbol is
  read from the literals right after the opener as a scan format is (splices joined before
  escapes, raw strings in C++), or from the pragma's tokens; with the Mach-O `_` prefix
  (`_strcpy`) or an ELF version (`strcpy@GLIBC_2.2.5`) it is the same function. A member named
  `alias` or `weakref` (`cmd.alias("system")`, `opts->weakref("popen")`) is no attribute;
- `native.identifier-splice`: a backslash-newline inside a name, which the compiler joins into
  one identifier (`str\` + `cpy(`) that no rule could otherwise see;
- `native.trigraph`: in the C17 reading (`.c .m`, headers, and a `.C` or `.M` that is not
  configured with a C++ standard), `??/` anywhere in the source,
  `??'` where the masker takes its `'` for a quote (in code, or closing a character literal), and
  `??=` in code. Clang replaces trigraphs before comments and literals exist in ISO C before C23,
  so `str??/` + newline + `cpy(d, s);` is a strcpy call there, `'??''` is the literal `'^'`, and
  `??=pragma` is a directive. These three are the trigraphs that join lines, escape or stand in for
  a quote, or start a directive, and until the first of them the masker reads as clang does, so
  each is found where it first matters; the other six only spell punctuators no call rule reads.
  C23 has no trigraphs, and neither have C++17 and later, the only C++ standards Praesidium
  accepts, so the C23 and C++ readings and the C++ and Objective-C++ files (`.cpp`, `.mm`, ...)
  are not checked (`// shown as ??/??/????` in a `.cpp` is a comment). Clang warns where these
  matter (`-Wtrigraphs`, and `-Wcomment` for one that continues a comment), so analyzed units fail
  on them anyway; the rule covers sources that are not analyzed;
- `native.named-ucn`: a named universal character name (`\N{...}`, also split by splices) in code.
  Literal contents are blanked in the view the rules read, and a name of Unicode whitespace is
  layout there (as it is for clang), so only a named UCN in an identifier or a number, or one
  standing alone, is rejected. Clang ends a pp-number at an invalid name in a skipped `#if` group
  (`1\N{NOPE}'a/*`, also the abbreviation `\N{NBSP}`), while the lexer, which has no Unicode name
  table, continues it, so the rest of such a line could hide the code after the group;
- `native.ambiguous-header-name`: an `#if`, `#elif`, `#pragma` or `#embed` line holding a `<` whose
  header name, read as clang reads one (to the first `>` on its line, splices with or without
  blanks before the line end joined, each escaped character skipped, so `<a\>/*b>` ends at the
  second `>`), ends at a `>` hidden by a comment or literal the masker opened in between. Clang
  reads `<...>` in `#if` and `#elif` as one header name when the tokens before it expand to
  `__has_include (`, also through a macro (`#define HAS __has_include` and then
  `#if HAS(<compat/*.h>)`) that no lexer can see, and in `#embed`, `#pragma GCC dependency` and
  Microsoft's `#pragma include_alias` always; it then compiles the code the masker hid. The masker
  reads a header name only after `#include`, `#include_next`, `#import` and a literal
  `__has_include (`, so the line is rejected rather than read either way, and every `#pragma` line
  is read because each pragma handler decides on its own whether it takes a header name. Lines on
  which the readings agree, such as `#if A < B && C > D`, `#if H(<a:>)` (where `:>` is a digraph)
  or `#if __has_include(<a/*b>)`, are not affected. Neither is valid C23 such as
  `#if A < 1'000 && B > N / 2`, `#if A < 1'000 && B > 2'000` or
  `#if PAGE < 8'192 && ALIGN > 8 && ALIGN < 64 // fits in one page` in a `.c` or `.h` file, whose
  C17 reading takes the digit separator's `'` for the start of a character literal. In `#if` and
  `#elif`, a `>` hidden only by a literal that opens at the `'` right after a pp-number (not after
  a name: `$1` and `é1` are names, a run with a `$` is one) is let through when the rest of the
  line after it, read as tokens, is inert: before a trailing `//` comment or character literal it
  holds no `'`, `"`, backslash or line break; a `/` in it is division or opens a block comment that
  closes on the line; it may end in a `//` comment or in a character literal that holds no `'`
  (both run to the line end); when a `<` outside its comments has a `>` after it on the line, it
  holds neither a comment nor a `'`, since another header name there would read them as plain text
  (a `<` with no `>` after it is a punctuator in every reading, so `&& C < 3 // note` may follow);
  and it names no word `native.analysis-suppression` rejects. Read as a header name the line then
  ends in condition tokens, the masker's literal (which ends at the next `'` or the line end)
  leaves no comment open, and the next line starts in the same state in every C17 reading. Such a
  `<` does not end the check: where the masker's literal closes on the line, the code after it is
  checked like the rest of the line, since a header name there could open a comment the masker
  closes (`#if F(0 < 1'>') || H(<x/*>) /*/`, with `F(...)` taking any tokens, is rejected).

A lone CR ends a line for attribution, as it does for the compiler. The JS/TS masker keeps its
regular expressions, but every alternative now ends at its closing token, a line end (quoted
strings) or the end of input: an unterminated `/*` or quote is consumed once instead of being
rescanned from every later position (a 1 MiB file of `/* ` took 75 seconds). An opener that never
closes hides at most the rest of its own line. A quote ends at the line end, and once a `/*` or a
backtick finds no closer, no later one of its kind can close either (there is no `*/` after it, and
every later backtick is an escaped character of that template), so from there on that kind also
ends at the line end, still in one linear pass. The masker does not recognize regular-expression
literals, so a quote, `/*` or backtick inside one still pairs with a later closer when there is one:
on the same line for a quote, and anywhere later for a `/*` (a later `*/`) or a backtick (a later
template literal), hiding the code in between.

C/C++ masking (`src/praesidium/native-lexer.mjs`) follows the language's lexical rules instead of
a regular expression, which valid C++ could steer into masking real code: a digit separator
(`1'000`), a raw string containing a quote (`R"d( " )d"`), a header name with a comment opener
(`#include <a/*b>`, `__has_include(<a/*b>)`) and an apostrophe in `#error don't` each hid a
following `strcpy(` call. The scanner forms pp-numbers, encoding prefixes, raw strings with their
delimiters, header names and line splices like the compiler, and recognizes a directive after a
leading comment, through the `%:` digraph or across a splice, and a comment end split by a splice
(`*\` + newline + `/`). Ordinary literals end at the line end (an unterminated one is ill-formed),
and a malformed or unterminated raw string masks only its own line, so a stray quote can never
hide later lines. It runs in linear time: raw-string terminators are indexed once per file and the
last `\N{` name scan is reused, so adversarial input cannot make masking quadratic.

Tokens are read as clang reads them (checked against clang 18). A line splice is a backslash,
optional blanks and one line break (CR LF and LF CR count as one), and every token is read across
splices: the character of an escape (`"a\\` + newline + `b"` is `"a\b"`), a raw string's prefix and
its quote, and the two characters of a digraph. A splice inside a literal does not end the line, so
a `#include` right after `"a\` + newline + `b"` in a macro body is the `#` operator, not a
directive. A header name skips escaped characters as clang's `LexAngledStringLiteral` does, so
`__has_include(<a\>/*b>)` holds one name. The text of `#error`, `#warning` and `#pragma mark` is
read raw to the end of the logical line, as clang's `ReadToEndOfLine` reads it in an active group,
and masked like a literal's contents, so a quote or a `/*` in it opens nothing. A pp-number is read as clang's
`LexNumericConstant` reads it: digits, letters, `_` and `.`; a sign after `e` or `E`, or after `p`
or `P` in C or in a C++ hexadecimal number; a digit separator before an ASCII letter, digit or `_`;
and a universal character name (UCN) or a non-ASCII character other than Unicode whitespace. A sign
never directly follows a separator, a sign or one of those characters. An identifier also continues
through UCNs. A `\uXXXX`, `\UXXXXXXXX` or `\u{...}` UCN continues either one when it names U+00A0 or
above and is neither a surrogate nor Unicode whitespace; one naming a lower code point or a
surrogate is a token of its own. A `\N{...}` UCN runs to its `}` on the line whatever it holds, so a
`/*` or a quote inside it opens nothing; it continues an identifier or a pp-number when it holds
only name characters (capital letters, digits, space, hyphen) and is a token of its own otherwise.
Unicode whitespace, raw or as a UCN (also `\N{NO-BREAK SPACE}` and the other names of clang's
Unicode whitespace), separates tokens. Limits: other names cannot be checked without the Unicode
name table, so every other name of name characters continues a pp-number or an identifier, as a
valid name does (ending the number there instead would let a valid name hide code the same way).
Clang rejects an invalid name in compiled code but not in a skipped `#if` group, where it ends the
number before `1\N{NOPE}'a/*` reaches its `'` while the lexer does not, which would hide the code
after the group; `native.named-ucn` rejects every named UCN the logical view keeps in code, so no
such name reaches the rules. Trigraphs, which clang reads under `-std=c11` and `c17`, are not
modeled; `native.trigraph` rejects the three that move a boundary the lexer draws (`??/`, `??'` and
`??=`). Clang reads the text of `#error`, `#warning` and `#pragma mark` raw, and Unicode whitespace
in a directive head as layout, only in active groups: inside a skipped group a `/*` there opens a
comment for clang, so the rules may report code that clang comments out (accepted: the masker does
not track `#if` state).

The lexical rules depend on the language, and the rules read a file under every set its compiler
might use, uniting the findings: C (`.c`, `.m`) has neither raw strings nor `import`, and has digit
separators only from C23, so it is read with both C17 and C23 rules (C++ rules let `R"(` or `1'0'`
hide C code); C++ and Objective-C++ use C++ rules; headers and an unconfigured `.C` or `.M` use all
three, and a configured `.C` or `.M` those of the language its standard declares. The C17 and C23
rules read a source alike unless it holds a `'` (a digit separator is the only difference), so a
source without one is read once for both, under the C17 rules, which also run the trigraph rule.
The rules match on the logical view, the form the preprocessor acts on: line splices (also inside
literals, header names, numbers and digraphs) and the line breaks inside block comments are blanked so each
logical line is one physical line, digraphs read as their punctuators, and layout other than a space
or a tab (`\v`, `\f` and Unicode whitespace, raw or as a UCN) is written as spaces, which every rule
reads as layout (a JavaScript `\s` misses U+0085 and U+180E, and U+2028 would end a line for `^`).
The view keeps every offset of the source, and line numbers come from the source, so a finding
inside a joined logical line keeps its physical line.

`native.analysis-suppression` rejects the in-source switches that make clang drop analyzer reports
or warnings for the code that follows: every GNU linemarker (`# 1 "x" 3`; clang macro-expands the
file name and flags after the number, so `# 1 "x" SYS` with `#define SYS 3` carries the
system-header flag too, and hand-written source has no use for one),
`#pragma clang|GCC system_header` and Microsoft's `#pragma system_header` (honored on
`*-windows-msvc` targets), `#pragma clang|GCC diagnostic ignored|warning`
(also written `%:pragma`, split by a comment or a splice), any `_Pragma`, any `__pragma` (Microsoft's
pragma operator, active on `*-windows-msvc` targets: clang macro-expands its tokens, so no rule can
read what it switches, and its MSVC `warning(...)` form is rejected with it), the `suppress` attribute
anywhere inside an attribute specifier, `[[clang::suppress]]`, `[ [ ... ] ]`, `<:<: ... :>:>`,
`[[using clang: suppress]]`, an unscoped `[[suppress]]`, `__attribute__((suppress))` or
`__attribute((suppress))`, across lines, at any distance from the opener and at any depth (a
function-like macro can move the word into parentheses; a bracket stack finds the specifier in one
linear pass, a directive's own brackets neither open nor close it, an attribute a `#define` leaves
open stays open after it, and directive lines between the two brackets of an opener, as in `[` +
`#if 1` + `#endif` + `[clang::suppress]]` or `__attribute__(` + `#if 1` + `#endif` + `(suppress))`,
leave it an opener), except where the gsl scope qualifies the word with no directive line in
between (`[[gsl::suppress("type.1")]]`, the C++ Core Guidelines spelling for MSVC's code analysis,
which clang's analyzer ignores; a skipped `#if 0` group around `gsl`, or an `#include` between
`gsl` and `::suppress`, can make it `clang::suppress` for clang), a
`#define` or `#undef` of `suppress` itself or of `gsl` (which would turn `gsl::suppress` into
another scope), `analyzer_noreturn` anywhere in code (the analyzer ends every path at a call the
compiler builds as returning, so nothing after it is checked; an alias of the word is caught where
it is defined; the analyzer does the same at a fixed list of function names, which no syntactic
rule can reject, see Evidence / limits), and any reference to `__clang_analyzer__`,
`__INCLUDE_LEVEL__` or `__BASE_FILE__`. A header job compiles the header as the main file, where
`__INCLUDE_LEVEL__` is 0 and `__BASE_FILE__` names the header, as in no product build, so code
conditioned on them could hide from the header job, or fail it on purpose so that the header is
reported as not analyzed (RV-PRAESIDIUM-03). The suppress attribute is also found after macro
expansion, by the expansion pass of analyzed files (RV-PRAESIDIUM-03). Clang takes form feeds and
vertical tabs as directive whitespace, so the rule does too. Each does what a PR-supplied `-w` or
`-isystem` flag would. A directive reports the line of its `#`, also when a comment or splice
before it is joined into its logical line.
Like the JS rules, there is no allowlist or configurable suppression, whether or not the pragma
carries a reason and push/pop: AIFormat RULE_CODE_CPP §C9.4 permits that form for compiler
warnings, and the decision of 2026-11-08 keeps Praesidium strict; §C9.4 is to narrow its permission
to MSVC `#pragma warning`. A header-only third-party library is therefore brought in as a submodule
(not traversed) or a host package (`-isystem`), not as tracked files: the nlohmann/json single header
alone holds 82 such lines. Code that only the analyzer would see is handled at the source of the
problem: the analyzer pass undefines `__clang_analyzer__`, so it reads exactly the code the compiler
builds, however a condition on it is spelled. A `_Pragma`, `__pragma`, `analyzer_noreturn`,
`__INCLUDE_LEVEL__` or `__BASE_FILE__` assembled by token pasting through macro parameters
(`CAT(__INCLUDE_, LEVEL__)`) is outside what a syntactic rule can see and remains a documented gap
(RV-PRAESIDIUM-03). Odeum's 240 native files contain none of these switches.
Whole-template masking deliberately avoids false positives in generated source text; actual
template-expression execution remains a coverage gap, covered by other reviews, not by this scanner.

### JS evaluator identity versus service methods

`web.dynamic-code` identifies bare `eval` / `Function` calls and calls qualified by
`globalThis`, `window`, `self` or `global`, including optional-call syntax. A method
on another receiver (such as Redis `eval`, which executes Lua on Redis rather than
JavaScript in the process) is not a direct JS evaluator. Typed TS parameter
declarations are not runtime calls. These distinctions apply uniformly, with no
repository/path allowlist or configurable finding suppression. Aliases and arbitrary
object properties that refer to a built-in remain outside this syntactic rule;
this is not a semantic proof of their safety. Other review stages still apply.

The receiver check walks back over whitespace only, so no comment or layout between the receiver
and the call (`window/* ... */.eval(code)`) can push the receiver out of view, and each call costs
only the whitespace in front of its own tokens: the rule stays linear however many calls share a
line (a 2 MiB line of `eval(x);` took 96 seconds when every call rescanned the text before it).
The layout between the name and the `(` (or the `?.` and the blanks after it) is read once, so
`eval` before a long run of blanks, line ends or a comment with no `(` after it also stays linear
(with two `\s*` competing for one run, 128 KiB of blanks took 8 seconds).

Regression coverage preserves direct/global calls, object and ternary arguments,
comment-separated globals of any length, line attribution, Redis calls, typed test doubles and a
2 MiB line of repeated calls.
This correction addresses Actio `23bc8364-69fb-40bc-9c0a-401700bde8ea` / Cernere PR3494.

## RV-PRAESIDIUM-02: Compile web field contracts once; reject at runtime ingress

`src/praesidium/input-guard.mjs` exports `compileRouteGuard(contract)`. Compile at service startup,
then call the returned guard with the **raw, unnormalized** request target before routing and
before doing application work. Use the returned sanitized `params/query/body`, not the raw input.
This is Node-compatible, framework-neutral code, with no application code imports during inspection.

Accepted fields are explicitly enumerated. Supported fields are bounded strings (optional slug,
UUID or enum), safe integers with min/max, and booleans. Unknown fields, non-scalar bodies,
duplicate JSON keys, duplicate/encoded duplicate query parameters and malformed JSON are rejected.
The body is parsed before its keys are read for duplicates, so every string the key scan meets is
closed and the scan reads each character once (an unclosed `"\"\"\"...` had it rescan the rest of
the body from every quote).
Paths reject dot segments, encoded slash/backslash, residual percent escapes (double decode risk),
controls and malformed escapes. Methods and literal path segments must match. JSON requests require
the declared content type. Target length is capped at 4096; body bytes are checked before JSON.parse.
Contracts allow at most 64 fields, 256 enum values and a 1 MiB body ceiling.
No user-supplied regex is compiled, avoiding a new regular-expression denial-of-service surface.

The caller **must also cap body bytes while receiving the stream**, before accumulating `bodyText`.
This library does not own sockets, proxy normalization, authentication, authorization, CSRF,
SQL parameter binding, contextual HTML escaping or rate limiting. A valid string remains data,
not safe HTML/SQL/shell syntax. Quotes and Unicode in free text remain valid where the schema permits.
Dynamic requests cannot be validated at build time; the build validates the policy and regression
examples, while the precompiled bounded guard enforces it at ingress.

Declare shared production contracts and positive/negative examples in `praesidium.json`:

```json
{
  "version": 1,
  "native": [],
  "web": [{
    "name": "get-item",
    "contract": {
      "method": "GET", "path": "/items/:id", "maxBodyBytes": 0,
      "params": {"id": {"type": "string", "format": "slug", "maxLength": 32, "required": true}},
      "query": {"page": {"type": "integer", "min": 1, "max": 100}},
      "body": {}
    },
    "cases": [
      {"request": {"method": "GET", "target": "/items/abc?page=1"}, "accept": true},
      {"request": {"method": "GET", "target": "/items/%2e%2e"}, "accept": false}
    ]
  }]
}
```

Service usage (load the same checked-in config through the service's configuration loader):

```js
const guard = compileRouteGuard(config.web[0].contract); // once, at startup
const checked = guard({ method: req.method, target: req.url, bodyText, contentType });
if (!checked.ok) { res.writeHead(checked.status); res.end(); return; }
// Only now use checked.params / checked.query / checked.body in the handler.
```

The runner also supplies mandatory traversal, double-encoding, malformed-escape, prototype-key and
oversize probes. An invalid contract or missing acceptance/rejection examples is an error.
The result always says `webRuntimeWiring: not-verified`: passing a contract suite cannot prove
that a service actually calls the guard. That requires the service's registered integration tests.
Without web contracts the report explicitly has `webContracts: 0`; no claim of protected routes is made.

## RV-PRAESIDIUM-03: Native compile-time analysis

Native configuration is required for the C/C++ files the reviewed change touches, not for every
native file in the repository. The review test stage passes the PR's changed set: paths added or
modified in the worktree relative to its merge base with the base branch, plus nonignored new files;
deleted paths are excluded (`changedSourcePaths` in `files.mjs`, wired through `mergeBase` in the
`runner.mjs` test-stage options and `praesidium-ci.mjs`). With that set:

- every changed translation unit must have a `native` entry, otherwise `native.configuration-required`.
  Objective-C/C++ (`.m`, `.mm`, `.M`) is the exception: its analysis needs the platform SDK, which an
  inspection host may not have, so an unconfigured changed unit is listed in
  `coverage.nativeNotAnalyzed` (explicitly not analyzed) instead of blocking every change to it.
  It is still policy-scanned; a configured one is compiled like any other unit. The preflight
  result carries the count as an advisory, which the gate shows on the board, so such a change
  never looks like a fully analyzed pass;
- every changed header is analyzed as the main file with the configuration of a configured unit of
  its own language that can see it: the header lies under one of that unit's `includes` or in the
  unit's own directory. The language is read from the header's masked logical text (comments and
  literals never decide it) line by line, a lone CR, CR LF or LF each ending a line as it ends a
  directive for the compiler, with its conditional groups taken into account:
  - Objective-C when `#import` or `@interface`/`@protocol`/`@implementation`/`@class` is compiled
    unconditionally (outside every `#if` group; a whole-file include guard, `#ifndef X` or
    `#if !defined(X)` then `#define X` with no code outside it, does not count, while a
    guard-shaped `#ifndef _MSC_VER` with code outside it is a condition one compiler may skip).
    Such a header is compiled with a visible Objective-C unit: an Objective-C++ one (`.mm`, or a
    `.M` declared with a C++ standard) when the header is C++ by the next rule (a C++ extension or
    C++-only spellings), else an Objective-C one (`.m`, or a `.M` declared with a C standard)
    first, whatever their order in `praesidium.json`. Without one, a
    visible portable unit first runs a probe pass that only preprocesses the header (`-E -P -w`,
    its header language, the output read from the process and never shown): the header goes on to
    be analyzed like any other with that unit when every include and import resolves, no `#error`
    fires and no `@` stands outside a literal on a line of the preprocessed text other than a
    directive clang prints (`#pragma`, `#ident`), which is Objective-C syntax, the header's own or
    an imported header's.
    When that header's diagnostics pass then fails, two more processes parse it without warnings
    (`-fsyntax-only -w`): in the unit's language, and as Objective-C (`-x objective-c-header` or
    `objective-c++-header`, with `-fblocks`). A header that parses only as Objective-C (a message
    send such as `[target ping]`, or a block type `void (^)(int)` on hosts other than Apple's,
    whose C has blocks; neither holds an `@`) is not analyzed either; one that parses in its own language failed on a warning, and one that parses
    in neither failed, so both stay failures. Exit codes alone decide. Only such headers are
    reported in `coverage.nativeNotAnalyzed`, like an unconfigured `.mm`: Odeum's ScreenCaptureKit
    header (the framework is missing on the host), an umbrella header that `#import`s a local
    Objective-C header, a header that declares `@class`, a header of block types. A header whose
    imports resolve and that parses in its language is compiled, so one that is not self-contained
    fails as any header does. A marker inside a group (`#ifdef __OBJC__ @class NSView; #endif`,
    `#if 0`) does not make a header Objective-C, and a GNU `#import` of a C++ header
    (`#import <cstdlib>`) does not exempt one. A header whose only Objective-C markers are inside
    groups is handled as Objective-C when no portable unit can see it (by directory: under one of
    its `includes` or in its own directory; an include line in a portable unit does not count):
    compiled with a visible Objective-C unit as above (a mixed bridge header that only a configured
    `.mm` sees), else not analyzed. With no unit able to see it at all, an Objective-C header stays
    not analyzed;
  - C++ for a C++ extension, or for C++-only spellings (`namespace`, `template`, `class`,
    `static_cast`, `reinterpret_cast`, `::`) in the code a C compiler would read: groups taken only
    under `__cplusplus` (`#ifdef __cplusplus`, `#if defined(__cplusplus) && ...`,
    `#if __cplusplus >= 201103L`) and the content of `[[...]]` attributes are left out
    (`[[gnu::always_inline]]` is valid C23). It needs a C++ unit; a `.h` with no visible C++ unit
    falls back to a C unit, which compiles valid C (a member named `class`) and rejects real C++,
    so a C-only repository is never stuck on `native.configuration-required`;
  - C and C++ for a `.h` that tests `__cplusplus` and lets C++ read other code than C reads.
    Lines no compiler reads, a `#if 0` or `#elif 0` group and the groups inside it (the cc-mode
    idiom `#if 0` + `}` + `#endif`), count for none of this. It tests `__cplusplus` other than in
    a plain group condition (an `#elif`, `#if defined(__cplusplus) || defined(X)`, a use in code
    or in a definition such as `#define IS_CXX __cplusplus`), or its own groups make C++ read
    other code than the code C reads inside C++ linkage, less the lines only C reads: a group
    only C++ takes (`#ifdef __cplusplus`, `#if __cplusplus >= 201103L`, ...) holds code other
    than `extern "C" {` (also across lines), `extern "C"` and `}`, or holds them where a brace or
    parenthesis of the code C reads is open (with a later `extern "C" {`, a `}` inside a function
    would move statements out of a block for C++ alone); code in a group only C takes (its
    `#else`, `#ifndef __cplusplus`) uses a pragma operator (`_Pragma`, `__pragma`, whose text the
    masked view hides, so it may restore a definition for C alone); or a group of either
    language holds a directive that can change what the code after it means in the other
    language: a `#define` other than of linkage boilerplate
    (`extern "C" {`, `}`, `extern "C"` or nothing, as in glibc's
    `# define __BEGIN_DECLS extern "C" {`), an `#undef`, an include (`#include`,
    `#include_next`, `#import`, `#embed`), a `#line` or GNU line marker (`__LINE__`, `__FILE__`),
    or a pragma that saves or restores a definition, renames an include or imports a module
    (`#pragma push_macro`, `pop_macro`, `include_alias`, `clang module`). A boilerplate macro
    defined in such a group, and a macro whose definition outside the groups uses one, directly
    or through other such macros (an export macro `#define VEC_API VEC_EXTERN_C VEC_EXPORT`),
    count too when the header uses one inside braces or parentheses in a line C++ also reads (a
    stringized `XSTR(END_DECLS)`; X11's `Xalloca.h` defining an empty macro only for C and using
    it inside the parentheses of a declaration only C reads is fine), names one inside braces or
    parentheses of a definition, removes one, tests one in a condition after the header first
    defines or removes it (glibc's `string.h` defines `__CORRECT_ISO_CPP_STRING_H_PROTO` for C++
    alone and tests it to pick C++ overloads; a test before that, as freetype's
    `#ifndef FT_BEGIN_HEADER` around its own definitions, is fine), or names one in another
    directive. Braces and parentheses are counted in the code C reads where a
    macro of the header is used after its definition, as many as its body opens or closes, not
    where it is defined (a block macro `#define LOCKED(v) { lock(v);` moves nothing until code
    uses it), and each branch of a group starts from the depth before the group, the branches C
    may read having to end at one depth (a function head split over `#if`/`#else`, each ending
    in `{`, shares one `}`). Branches that end at different depths may be brought back to one by
    the next group when it begins with the same conditions, which takes the same branch, so each
    of its branches starts where the earlier group's ended (a further `#elif` where the earlier
    `#else` did; `#if USE_INLINE` opening a function body that its `#else` only declares, then a
    second `#if USE_INLINE` with the rest of the body and its `}`): the groups are matched by the
    text of their conditions, so nothing may change those between them (no other line between
    the groups, no definition, `#undef`, include, `#pragma push_macro`-like pragma or pragma
    operator in the first, no `__LINE__` or `__COUNTER__` in the conditions). The header is also written for both when that depth cannot
    be told: a `}` or `)` with none open (a macro of another header opened it), a digraph or
    trigraph brace, branches that end at different depths without such a next group, or a macro
    that moves the depth and is defined inside a group, defined twice with different depths,
    removed, built from another such macro, spells a brace otherwise, or takes arguments and is
    named without `(`. It is compiled once with a visible C unit and once with a visible C++
    unit, so neither language's reading goes unanalyzed (`#ifdef __cplusplus` inline code is
    compiled by no other pass). Revisor's own baseline header is such a header;
  - C, and C++ only when C++ reads it, for a C header with C++ linkage: a `.h` that tests
    `__cplusplus` only in plain group conditions and whose C++ reading is the code C reads, with
    `extern "C"` linkage around its declarations, less the lines only C reads (none of the above;
    code only C reads anywhere, such as `linux/keyctl.h`'s member named with a C++ keyword or a
    check only C has, a message, another pragma such as `#pragma pack` or
    `#pragma GCC diagnostic`, and linkage boilerplate used only where the linkage may stand are
    fine). Its body is C, which need not be valid C++ (an implicit conversion from `void*`), so
    it is compiled with a visible C unit (a C++ unit when only C++ files include it), and also
    with a visible C++ unit when C++ reads it: a C++ or Objective-C++ file, a `.C` or `.M` (by
    its declared standard when it is a configured unit, else always) or a C++-only header
    includes it by name, directly or through headers or fragments of either language that such a
    file reaches (found once per run; each source and name is visited once);
  - `nullptr` or `constexpr` (spellings C23 shares with C++): a C++ unit, else a `c23` C unit, else
    another C unit;
  - otherwise either language: a C unit first, unless the files that include it by name are all
    C++ (or Objective-C++), in which case a C++ unit first. Includers are found once per run from
    the `#include`, `#include_next` and `#import` lines of the collected sources, by the included
    name's last component; a C or Objective-C file or a C-compatible `.h` counts as C, a C++ or
    Objective-C++ file or a C++-only header as C++, and a `.C` or `.M` as the language its
    standard declares when `praesidium.json` configures it as a unit, else as both. Each name's
    includers are read once per run, however many changed headers share the name. A marker-free
    C++ `.h` that only C++ files include is thus compiled as C++ in a repository that also has C
    units.

  Picking the first visible unit regardless of language compiled a `.hpp` as C, and Odeum's
  ScreenCaptureKit header as plain C++ with a Windows unit's flags. A changed header no suitable
  unit can see is `native.configuration-required`. The units that can see a changed header or
  fragment are found by one walk down its path through a tree of the directories the configured
  units see (their own and their include directories), whose nodes hold the first unit of each
  kind by `praesidium.json` order (and, for fragments, all of them, each read for the first
  fragment that reaches it), so choosing units costs each changed file's path, not the number of
  units. The analyzer only path-analyzes functions
  defined in the main file, so inline and in-class code in a header was otherwise checked only
  where some unit happened to call it, and a header-only PR compiled nothing (this is AIFormat's
  proposal 3, done without a `covers` list). Function templates are still analyzed only where an
  analyzed unit instantiates them, so trust-boundary checks belong in non-template code (AIFormat
  RULE_CODE_CPP §C2.3). The diagnostics pass compiles the header as a header (`-x <language>-header`
  with `-fsyntax-only`: no `#pragma once` or unused-static noise, no PCH written) and ignores unused
  functions, which an including unit may well use; the analyzer pass uses `-x <language>`, because
  an analyzer job for a header language writes a PCH next to the header. Headers must be
  self-contained (include what they use).
  Without a changed set, headers stay covered through the units that include them;
- a changed fragment (`.inc`, `.def`: LLVM-style bodies and X-macro tables spliced in by
  `#include`) is not self-contained, so it is never compiled alone. The configured units that can
  see it by directory, or that include it by name (`#include`, `#include_next` or `#import`, which
  clang also reads in C and C++; its last path component, `../gen/ops.inc` included), directly or
  through headers that do, are compiled instead, each once and only when not already in scope, with
  the check reported under the fragment's name. Those units, with the units the change's other
  files outside the extension table select (next item), must fit in the room the unit limit
  leaves: 256 analyzed files, less the changed units and the header jobs. When they do not, every
  changed fragment keeps only the units that see it by directory and those whose compiler can read
  that very fragment through an include line they reach, matched by path as for the files in the
  next item, and the units that do no more than include its name give way: a change to one library's
  generated `ops.def`, when each of a hundred libraries has one that its public header includes,
  compiles the units that list that library's include directory, not all 300 units that include
  any of those headers. Past the room a fragment has the gaps of such a file (below): a unit that
  reads it by name only through a shape the path match does not see (an include directory reached
  through a symbolic link, or one the build adds that `praesidium.json` does not list) is not
  compiled for it, and since the other files' units count toward the room, their extra units (the
  gaps below) can push a fragment past it while its own units would fit, which leaves out a unit
  that the name match alone would have compiled. A fragment some native
  source includes but no configured unit reaches is `native.configuration-required`, or not analyzed
  (`coverage.nativeNotAnalyzed`) when only Objective-C units include it. `.inc` is also PHP,
  assembler, Pascal or BitBake, so fragments are not collected as policy sources: a fragment gets
  the policy rules where an analyzed unit's compiler reads it (the dependency scan below), and one
  that nothing includes by name and no unit sees is neither compiled nor scanned (a PHP `sprintf`
  or a Latin-1 assembler comment had failed or errored the scan of a repository without C);
- a changed file outside the extension table (a `.txt`, an extensionless or any other file that is
  not a native source) or a changed script source (`.js`, `.ts`, ...) is compiled the same way
  through each configured unit whose compiler can read that very file through an include line in a
  native source the unit reaches (its own file, or a header it includes by name, directly or
  through headers): a quoted path relative to the includer's own directory, which every compiler
  tries first, names it for every unit that reaches the line, and any line, quoted or angled, names
  it for a unit through a directory that unit lists in `includes`, climbing out of it with `../`
  (`#include <body.txt>` with `"includes":["share"]` names `share/body.txt`, and `<../body.txt>`
  with `"includes":["inc/sub"]` names `inc/body.txt`). A name alone never matches, and neither
  does another unit's include directory: a `src/app.cpp` that includes `<version>` is not compiled
  for a change to the script `tools/version` when only another unit, `tools/gen.cpp`, lists `tools`
  (selecting every unit that reached such a line had pushed a one-file change in a repository of a
  few hundred units past the unit limit). Climbs are matched by levels: the lines that spell the
  rest of the file's path below one of its directories first climb between a least and a greatest
  number of levels (0 for a line that does not climb), and they name the file when that range
  overlaps the range of levels below that directory at which units list directories (0 for the
  directory itself); a unit that reaches such a line is then selected when it lists a directory
  below a directory where some changed file was so matched, at a level within the climbs matched
  there. That is exact for one changed file that one line can name, apart from headers followed by
  name, a backslash read as a separator (see the gaps below), and a quoted line matched through an
  include directory, which also selects a unit whose compiler first reads a file of that name in the
  line's own directory; with more, a unit can also be selected through another line's climb, or
  through a directory it lists for another line or another changed file, which again only adds
  units (they do count toward a changed fragment's room, above). Those units are compiled under
  the file's name; the dependency scan below then applies
  the native policy rules to it. Without such a unit the file is left alone, never
  `native.configuration-required`: a name alone does not make a file C or C++. A unit that several
  changed files or fragments select is compiled once, under the first: the first file whose lines
  it reaches, or, when that comes later, the first file whose lines were matched under a directory
  above one it lists, at a level within the climbs matched there for any file, so a unit can be
  reported under an earlier file than the one whose line its compiler reads. The
  lookup reads the include lines once and keeps only what the changed paths hold: the changed paths
  form one tree from their first component and one from their last; a quoted line is resolved from
  its source's directory, found in the first tree once per source, and a spelled path is followed
  in the second only while it stays a suffix of a changed path, so a line costs its own length, not
  its source's path, and lines that name no changed file are not kept (with none, the include index
  is not built at all). Each changed file's path is then walked once through the configured
  directories and once through the spelled paths, with one constant-time check at each component
  however many climbs the spellings there hold. Each set of matching lines is read once in all: its
  translation units are selected directly, and its headers are followed up the include lines by
  name to the units that reach them in one walk for all the changed files, in their order (one for
  quoted lines, one for the others), so each header name is read once per walk. A unit's
  directories are checked once, by one walk up from each directory it lists. Changed fragments are
  found in one walk from all their names. The lookup is thus linear in the include lines, the
  configured directories and the changed paths;
- only configured units whose file is in the changed set, or that a changed fragment or other
  included file reaches, are compiled. Entries for unchanged files are still validated for shape
  (keys, standard, include/define grammar, duplicates, tracked file) but are neither compiled nor
  resolved against host packages;
- the 256 limit applies to the number of analyzed files (units, header jobs and units compiled for
  a changed fragment or other included file, the extra units that matching by name and by
  ranges selects included, see the gaps below), not to the length of `native`. Only the units
  that do no more than include a changed fragment's name give way when the units chosen would
  pass it (above).

A PR that edits `praesidium.json` also brings into scope every unit whose entry is new, differs
by value from the merge base's copy, or was removed from it (`reviewedPaths` /
`reconfiguredNativeUnits` in `files.mjs`; reordering keys or reformatting changes nothing). A
deleted `praesidium.json` declares no units, so deleting it removes every entry. Changing how a
unit is analyzed, or stopping its analysis, is therefore analyzed by the PR that changes it,
instead of passing with no unit compiled and failing the next, unrelated PR that touches the unit:
a removed entry whose file is still tracked is `native.configuration-required` in that PR (an
Objective-C/C++ unit is instead listed in `coverage.nativeNotAnalyzed`, as any unconfigured one),
while removing a unit together with its file leaves nothing to analyze, and renaming the file along
with its entry analyzes it under the new name. A
repository that adopts Praesidium analyzes every unit it declares. An unreadable base copy
configured nothing that still holds; a Git failure falls back to the whole-repository scope. The
review test stage (`praesidium-ci.mjs`) and the CLI's `--base` scope both use `reviewedPaths`.

Policy rules (RV-PRAESIDIUM-01) still scan every collected source; only native analysis is scoped.
Fail closed: without a merge base, or when Git cannot compute the changed set, the scan falls back to
the whole-repository requirement (every tracked unit configured and compiled). The report's
`coverage.nativeScope` is `changed` or `repository` accordingly. The CLI keeps the whole-repository
scope unless `--base <ref>` is given: `praesidium --repo <repository> --base origin/main`.
`--repo` may name a subdirectory of a Git repository: changed paths are then relative to it like
the collected sources (`git diff --relative`, which also leaves out changes outside it), and the
base copy of `praesidium.json` is the one in that subdirectory. Without `--relative` no changed
path matched a collected one, so a scoped run compiled nothing and passed.
The host needs `clang` / `clang++` on its trusted PATH or explicitly configured absolute compiler
paths in its host configuration. Praesidium never installs them automatically.

```json
{"version":1,"native":[{"file":"src/parser.cpp","standard":"c++20","includes":["include"],"defines":["FEATURE=1"]}],"web":[]}
```

Each analyzed file runs three bounded compiler processes with the same language, standard, includes
and definitions, and passes only when all pass (an Objective-C header compiled through a portable
unit runs the preprocessing probe above first, and the two syntax checks above when its
diagnostics pass fails; when they show that the unit's compiler cannot read it, the file is
reported as not analyzed):

1. a diagnostics pass, `-fsyntax-only -Wall -Wextra -Wformat=2 -Wvla -Wnull-dereference -Werror`
   with `-Wno-missing-field-initializers` (a partially braced aggregate zero-initializes the rest; it
   was the only warning Odeum's 70 package-free units raised, and the three added flags raised none);
2. an expansion pass, `-E -w`, whose preprocessed output (read from the process, at most 64 MiB,
   never written to disk or retained) is searched for the analyzer's suppress attribute (below);
3. the analyzer, `--analyze` with `core,cplusplus,unix,security,optin.cplusplus.UninitializedObject,
   optin.cplusplus.VirtualCall` and text output, `-U__clang_analyzer__` (above) and
   `security.insecureAPI.DeprecatedOrUnsafeBufferHandling` disabled: in C it reported every
   `snprintf`, `vsnprintf`, `memcpy`, `memmove` and `memset` (C11 Annex K advice), which left a C unit
   no accepted way to format or copy, while the unbounded APIs it targets are rejected by the policy
   rule and the baseline. Except on Windows hosts, `core.builtin.NoReturnFunctions` is disabled too:
   it ends every path at a call to a global C function (externally visible or inline, in the
   global namespace or `std`) with one of a fixed list of names (`exit`, `panic`, `error`, `Assert`,
   `__assert_fail`, ...) whether or not the callee returns, so glibc's `error(0, ...)` or a function
   of the repository named `panic` that returns would hide every report on the path after it, and
   `analyzer_noreturn` would make the analyzer drop paths the compiler builds as returning (a
   method named `error` is not on the list). Functions declared noreturn (`_Noreturn`,
   `[[noreturn]]`, `__attribute__((noreturn))`, `exit`, `abort`, glibc's, musl's and Apple's assert
   handlers) still end paths through the CFG, as does `throw`; a real-clang test checks both sides.
   The accepted price: a call that never returns but is not declared so continues the path, so the
   code after it can be reported. glibc declares `error` returning, since it returns for status 0,
   so the common GNU guard `if (copy == NULL) error(EXIT_FAILURE, errno, "...");` followed by a use
   of `copy` fails the unit (a real-clang test pins this). Such code ends the path itself: `abort()`
   or `__builtin_unreachable()` after the call, or a function of the repository declared
   `_Noreturn` (or `[[noreturn]]`) that calls `error` and then `abort()`; declaring a returning
   library function noreturn is not an option. On Windows hosts the checker stays on, because the
   UCRT's assert handler `_wassert` is not declared noreturn: without the list, the path an
   `assert` guards would continue and be reported.
   `cplusplus` (NewDelete, Move, InnerPointer, ...) is also a driver default;
   naming it keeps it if the defaults change (AIFormat's proposal 5). The two opt-in checkers (fields
   a constructor leaves uninitialized; virtual calls during construction or destruction) exist since
   clang 8 and raised nothing on Odeum's 70 package-free units. Alpha checkers, bounds and taint
   checkers included, stay off: their names change between releases (an unknown name fails every unit)
   and they are not stable enough to block merges. Raw-array and `memcpy` bounds are not proven;
   standard library bounds are the product build's hardening (AIFormat RULE_CODE_CPP §C2.9).

The clang driver adds `-w` to every `--analyze` job, so warning flags on the analyzer command line
never took effect: before the split, `std::printf(user)`, a returned dangling `std::string_view`
and `-Wsign-compare` defects all passed with exit 0 while `-fsyntax-only` rejected them. Enabling the
diagnostics pass makes the existing `-Wall -Wextra -Werror` promise real; a changed unit with
warnings that used to pass now fails. Real-clang regression tests (skipped where clang++ is not
installed) cover a format-string call, a dangling view, analyzer findings in units, module units
and changed headers (both opt-in checkers included), reports behind a returning `error` or `panic`
and behind the glibc `error(EXIT_FAILURE, ...)` guard, the suppress attribute reached through
expansion, and that analysis writes nothing into the checkout.

The expansion pass finds the analyzer's suppress attribute after macro expansion, however the
source reaches the word: an object-like alias (`#define QUIET suppress` with `[[clang::QUIET]]`), a
macro argument (`ATTR(suppress)`), a token paste, a `using` prefix, a header's macro, a configured
define (`"defines":["QUIET=suppress"]`) or the GNU keyword `__attribute((suppress))`. clang marks
each run of the output with the file and line it came from (its linemarkers); text from system
headers (the toolchain, host packages) is left out, and a system run inside an attribute that
repository code opened counts as a hit. The other directive lines clang prints (`#pragma`, `#ident`,
always with the `#` in the first column, while a `#` token of code that starts a line is printed
after a space and stays code) are left out too: none applies the attribute (`#pragma clang
attribute` rejects it), but their tokens could open an attribute that never closes and so hide
every later one, or close one before its `suppress` (`#pragma omp parallel [[`, which `-Wall
-Wextra -Werror` accepts without `-fopenmp`). A raw string literal is the one token that spans
lines in the output. From the first line of repository text that holds a raw string prefix (`R"`)
on, the output is masked as C++
before its lines are read, so a line inside a raw string, a pragma's raw string included, is never
taken for a linemarker or a directive (`# 1 "/usr/include/stdio.h" 3` in a raw string would turn
the rest of the file into system text, and `#version 330` in a shader is text). clang does not count
the line breaks inside a raw string, so until its next linemarker it prints each later line that
much lower; the reported line is corrected for it. A hit is a `suppress` or `__suppress__` at the
top level of an attribute list, scoped by any namespace but `gsl` (`[[clang::suppress]]`,
`[[using clang: suppress]]`) or in `__attribute__((...))`. Not hits: an argument
(`__attribute__((cleanup(suppress)))` names a function), a literal, `[[gsl::suppress(...)]]` (the
C++ Core Guidelines spelling, which the analyzer ignores), an unscoped `[[suppress]]` (an unknown
attribute the diagnostics pass already rejects; in Objective-C a message send) and any identifier,
member or parameter named `suppress`.
A hit fails the file and is reported as `native.analysis-suppression` at the repository line that
applies the attribute (the analyzed file when that line lies outside the repository), once when a
policy rule reports the same line. Scanning is linear in the output. Nothing is defined or renamed
for analysis that the product build lacks, so no `#ifdef suppress`,
`__has_cpp_attribute(clang::suppress)` or stringized `suppress` can show the analyzer other code
than the product build compiles. On MSVC-compatible targets clang writes `#line` markers without
the system flag, so all of the output is searched there.

The diagnostics pass also lists every file the compiler read (`-MD -MF <file> -MT praesidium`, into
a temporary directory outside the checkout that is removed afterwards; `-fsyntax-only` writes it, and
nothing else, with clang 18, also when the pass fails). The list is read as clang writes it: only a
space or a line break separates names, `\ ` is a space (the backslashes before it doubled), `\#` a
`#`, `$$` a `$`, and a tab, vertical tab or Unicode space belongs to the name (splitting on those
had turned `src/q<TAB>/etc` into a directory and a path outside the root, so the file was never
read). Each listed file that is the repository's own (inside the root, tracked or nonignored new by
`git ls-files`, so submodule content, host packages, the toolchain and the baseline are left out)
but not a native policy source (fragments included, and script sources, which the policy scan
reads with the script rules only) gets the native policy rules, read as a header (C17,
C23 and C++), under the collection limits (2 MiB per file, 32 MiB in all, both checked before any
file is read, strict UTF-8, no NUL; a file over them, more than 4,096 such files, or a listed name
inside the root that is not a file fails closed as an incomplete inspection). A listed file that
Git ignores is not read, as for any listed name outside that listing (an ignored file the compiler
reads is not scanned). The scan asks Git nothing itself: it reads the listing the collection read
(`git ls-files --cached --others --exclude-standard`, at most 4 MiB), so Git is asked for that
listing once per run (a changed-scope run also asks Git for its changes). A listed name is
resolved one component at a time as the system resolved it for the compiler: each `..` from the
directory reached before it and a link as its target, so through a link `src/link` to `deep/dir`,
`src/link/../x.txt` is `deep/x.txt` (removing `link/..` from the text had read a `src/x.txt` beside
it instead). What a component leads to from a directory is asked of the system once per scan, and
a directory reached again, by its name, after a `..` or through a link, is the one already reached,
so names that share directories share that work. The system still resolves a link's target whole,
and is asked for each directory by its whole path the first time, so many links into the depths of
one deep chain, or names in many distinct deep chains, cost more than their length (Evidence
below). A listed name that resolves to no file fails closed.
clang lists a name that holds a backslash with a slash there (`src/a\b.txt` as `src/a/b.txt`), so
such a listed name can stand for another file (a decoy `src/a/b.txt` beside the `src/a\b.txt` the
compiler read) or name nothing (`a\q/../data.txt` listed as `a/q/../data.txt`). So once any native
pass ran, a repository whose listing (the files Git tracks or would add, which collection reads)
holds a path with a backslash fails closed (`error`, inspection incomplete), whether or not a
compiler read that file, in either scope; in changed scope, a changed path that holds a backslash
fails closed too while units are configured (the gaps below). Such paths cannot be checked out on
Windows; failing closed on them is the accepted cost. A repository with such paths and no
configured units, or a run that compiles nothing and changes no such path, is unaffected. A file
outside the repository whose path holds a backslash, once a unit reads it, and every file a unit
reads when the checkout's own path holds one, are listed the same way, so the listed name names no
file and the scan fails closed too. Where a file with the slash spelling exists, the name stands for
it instead, outside the root, and nothing is read: for a host file that loses nothing, but for a
checkout whose path holds a backslash beside a copy of it under the slash spelling, the repository
files the units include go unscanned (a gap that needs control of the host's directories). Two gaps
remain in the repository itself: the listing holds no submodule content, so a backslash path inside
an initialized submodule is not caught (a name that climbs out of the submodule's `a\q` beside a
decoy `a/q` can stand for a submodule file instead of the repository file the compiler read, which
is then not scanned; this needs submodule content the CI checks out), and clang writes a line break
in a name raw, where the list separates names, so a repository path that holds a line break is split
into other names (`a<LF>b/x.txt` listed as `a` and `b/x.txt`), which can stand for other files, and
the file it names is then not scanned (where they name nothing, the scan fails closed). A finding
is reported against that file (rule, file, line) and fails the unit that read it; a failing pass's
list is read too, so its findings are reported as well. A `#pragma clang diagnostic ignored` or
`system_header` in an included `.txt`, extensionless or other file outside
the extension table had turned the baseline's deprecations and `-Wformat=2` off for the rest of the
unit while no rule read it; the compiler resolves the include, so a macro-named `#include QUIET_FILE`
is listed too. A pass that passed but whose list cannot be read or parsed is an `error`; an
injected executor that reports no list (the tests' fakes) has nothing scanned.

Every invocation names its language with `-x` (`c`, `c++`, `objective-c`, `objective-c++`): clang
reads `.ixx`, `.mpp` and `.inl` as linker inputs, and with `-x c++-module` it precompiles a module
unit and then analyzes the resulting PCM, reporting nothing. Module units are therefore analyzed as
`c++`. Standards are `c11 c17 c23` for C and Objective-C, and `c++17 c++20 c++23 c++26` for the rest;
`c++26` is passed as `-std=c++2c`, which clang 17 also accepts. A `.C` or `.M` unit takes either
kind, and its standard sets its language wherever a unit's language counts: a C standard compiles
it as `c` or `objective-c`, a C++ standard as `c++` or `objective-c++`, and the header rules above
take it as a unit of that language. Every process gets
`-fno-crash-diagnostics`: a crashing clang (clang 18.1.3 crashes on Odeum's `amf0.cpp`) otherwise
writes the whole preprocessed unit, header text included, to a world-readable reproducer in the
temporary directory. A unit that imports a named module (including `import std;`) cannot be
analyzed standalone yet and fails; no LUDIARS repository uses modules today.

The adapter never links or runs a binary, runs build/install scripts, loads analyzer plugins or
accepts arbitrary compiler options.
Repository-supplied include paths remain restricted to directories within the repository;
definitions have a narrow grammar, and may not name the macros that would switch off the unit's own
analysis (`__clang_analyzer__`, `PRAESIDIUM_*`), the names the baseline
spells (`_WIN32`, which skips it; `deprecated`, `__deprecated__` and `__attribute__`, which turn its
deprecation into another attribute such as `[[nodiscard]]` or `annotate`; `__cplusplus`,
`__has_include`, `__restrict`, `__builtin_va_list`, `__WCHAR_TYPE__`, `wchar_t`, `noexcept`, `std`),
nor the rejected API names (a `-Dsprintf=...` alias would rename them out of the baseline).
`-D_WIN32`, `-Ddeprecated=nodiscard` and `-D__deprecated__=__annotate__` each passed a unit that
reached `strcpy` or `sprintf` through a pointer or macro; a Windows build never passes `_WIN32`, which
the compiler predefines. Other reserved names stay usable (`__STDC_FORMAT_MACROS`). The report names
the offending unit and macro (both `praesidium.json` text, never source). Standard library
hardening macros are the product build's own choice and are compiled as written, so a unit can mirror its build as AIFormat RULE_CODE_CPP
§C2.10 requires (its `LUDIARS_CXX_HARDENING` presets emit `_GLIBCXX_ASSERTIONS`,
`_LIBCPP_HARDENING_MODE=...` and `_MSVC_STL_HARDENING=1`). `_FORTIFY_SOURCE` is accepted and not
passed on: it acts only in optimized builds, and at `-O0` glibc turns it into a `#warning`.
Host-installed libraries can be requested by package name
using `"packages":["tela"]` on a native unit. Only the administrator-owned `praesidium.host.json`
next to the resolved Revisor config can map these names to absolute include directories:

```json
{"version":1,"compilers":{"cpp":"C:/Program Files/LLVM/bin/clang++.exe"},"includePackages":{"tela":"C:/installed/tela/include"}}
```

The host config must be outside the reviewed repository, has a 64 KiB limit and at most 64
packages, and all configured locations must exist. Unknown packages fail closed. PR configuration
cannot supply host paths, executable names, install commands or compiler flags. Host libraries
are trusted toolchain inputs like SDK headers; their source and updates are an operator concern,
not a claim of inspected third-party code, so they are passed with `-isystem`: their own warnings
are not the reviewed change's (with `-I`, a vendor header's unused parameter failed the unit), while
analyzer reports reached from repository code still appear. No repository setup runs before security preflight.
This supports a cold checkout without running installers or copying unchecked code into it.

Per-process timeout is 60 seconds / output cap 2 MiB (64 MiB for the preprocessed output of the
expansion pass and the probe); at most two compiler workers run concurrently,
each running one file's passes in order and stopping at the first pass that does not pass. The
shared batch stops scheduling processes once its budget (RV-PRAESIDIUM-NATIVE-BUDGET) is spent,
reports every unfinished file as an error, and awaits all in-flight compilers. Configuration is
validated in full before workers start.
Actio `bb56075c-dbb1-4f6e-8aec-47e5f3fd7d28` scoped native analysis to the changed set after
Figmentum (464 native sources) and Pictor (288) could never pass the whole-repository requirement.
Missing compiler, invalid/missing configuration, timeout, output overflow
or diagnostic errors do not pass. Warnings fail even when Clang returns exit 0. Diagnostics are
not retained, because they can contain secrets from source/header content.
In-source analysis switches are rejected by the policy rule `native.analysis-suppression`
(RV-PRAESIDIUM-01), also in the repository files an analyzed unit reads outside the extension table
(the dependency scan above), and the suppress attribute also after macro expansion (the expansion
pass above). A compiler crash (`frontend command failed`) inspected nothing and is
reported as an `error` (incomplete), not as a `failed` finding about the unit.

Build variants/defines/include paths must match the product's build. Header inclusion coverage,
link-time behavior, third-party/submodule sources, concurrency and all memory errors are not proven.
Unsupported build contexts fail until configured or remain outside declared coverage, never a claim
that C++ has become memory safe. Rust's safe-code guarantees, runtime bounds checks, OS isolation,
compiler hardening and sanitizers remain complementary. Some attacks can be prevented at runtime;
the premise that runtime protection is inherently impossible is not adopted.

Documented gaps of the native analysis (each found in review and left open on purpose):

- Code under a condition that analysis does not share with every product build is not analyzed:
  build configuration the unit does not declare (`__OPTIMIZE__`, an `NDEBUG` the build sets) and
  compiler or platform identity (`#ifndef __clang__`, `_MSC_VER`). Analysis compiles what clang
  builds with the unit's declared definitions; no syntactic rule can ban such conditions. Only
  `__clang_analyzer__` (undefined) and the baseline's own macros (none left defined) are closed,
  and analysis defines nothing else;
- a header job compiles the header as the main file, where `__INCLUDE_LEVEL__` and `__BASE_FILE__`
  differ from every product build. `native.analysis-suppression` (RV-PRAESIDIUM-01) rejects both
  names as written, but a name assembled by token pasting (`#define CAT(a, b) a##b` and
  `#if CAT(__INCLUDE_, LEVEL__) > 0`) is outside a syntactic rule, so a header can still keep a
  body out of its own header job while every product build compiles it. Compiling the header
  through a stub main file that includes it would close this, but the analyzer would then no
  longer path-analyze the header's functions. Likewise `__FILE__` is spelled as the header job
  names the header (its repository path), which can differ from the spelling a product build's
  include path gives, so a constant-expression test on it could tell the two apart; it cannot be
  rejected, since `assert` and logging use it;
- an Objective-C header, by its unconditional markers, that a visible portable unit cannot compile
  (it fails the preprocessing probe, or parses only as Objective-C) is reported as not analyzed
  (an advisory on the board) whatever the reason, since compiler diagnostics are never parsed: an
  include or import that does not resolve (a missing framework, a header only the product build
  generates), Objective-C syntax in the header or in what it reads (an `@` outside literals and
  printed directives, a message send, a block), or an `#error` that fires only when the header is
  preprocessed alone (a private header's `#ifndef FOO_INTERNAL` check), which the product build
  never sees. So is one that fails to parse alone in its unit's language but parses as
  Objective-C because its product includer supplies what Objective-C predefines or enables
  (`typedef void *id;` before the include, or `-fblocks` on the build's command line). Making a
  C++ header look so takes an unconditional GNU `#import`, which the product's own build must also
  accept (MSVC reads `#import` as a type-library import, GCC deprecates it), and one of those
  reasons. A header whose Objective-C markers are all conditional (`#ifdef __OBJC__`) goes the same
  way only when no portable unit can see it by directory (a portable unit that includes it by a
  relative path does not count) and no visible Objective-C unit is configured;
- in C++, the baseline's six declarations are visible to name lookup even in a unit that includes no
  C library header, so a requires-expression or SFINAE test on one of those names can tell analysis
  from such a product build and choose different code (deprecation is not reported in that
  unevaluated context). Declaring them first is what lets the library's later declaration inherit
  the attribute, so this is not closed;
- a header with C++-only spellings outside its `__cplusplus` groups is analyzed only as C++, so
  code under `#ifndef __cplusplus` in it is analyzed only through C units that include it
  (compiling such a header as C fails on its unguarded C++);
- the header language is a heuristic of spellings and includers by name; a misjudged header fails
  (it is compiled in the other language), it never passes unanalyzed;
- a C header with only C++ linkage boilerplate gets its C++ job only when C++ in the repository
  reads it by name (a C++ file or a C++-only header includes it, directly or through other
  headers); one that C++ code reaches only through a macro-named include or a file outside the
  extension table, or that only other repositories include from C++ (a library's public
  header), is compiled as C alone. Its own groups give C++ the code C reads, inside linkage, less
  the lines only C reads, and the same definitions apart from the linkage boilerplate, but a
  C++-only meaning that comes from those lines missing (a check only C has, so C++ reads the
  function without it; a member only C has; a function head only C reads, so C++ gives the next
  body to the head before it; a declaration of the same name as one only C takes, which C++ then
  takes from elsewhere: `typedef long size_type;` under `#ifndef __cplusplus` and an included
  header's `int` one), from what it reads (a macro an included header defines differently for
  C++, or defines before a test of a boilerplate macro, a brace or parenthesis such a macro
  supplies, which the depth count does not see), from a test of another macro
  (`__STDC_VERSION__`, a `__cpp_*` feature macro), from a pragma that compiles the same code
  differently (`#pragma pack` in a C++ group), or from groups matched by the text of their
  conditions whose value differs anyway (a macro defined as `__LINE__` that both test) is then
  analyzed only where a C++ unit in scope includes the header. C++ groups' own linkage braces
  are not balanced against each other: an extra `}` that closes no `extern "C" {` and a later
  `extern "C" {` leave C++ an ill-formed reading, which only such a C++ job shows;
- two costs of that reading are accepted on purpose (owner decisions). An include in a group only
  C takes (`#ifndef __cplusplus` + `#include <stdbool.h>`) makes the header written for both, so
  it also gets a C++ job, which fails when its body is not valid C++. And a header whose lines
  only C reads (a check, a member, a function head) give C++ another meaning stays a C header with
  C++ linkage, so C++'s reading of it is analyzed only when the header gets a C++ job: when C++
  reads it by name (a C++ file or a C++-only header includes it, directly or through headers) or no
  C unit can see it, not because a C++ unit can see it by directory;
- the header-language check reads a pragma operator only where it is written: a macro whose body
  holds `_Pragma` or `__pragma` (`#define POP _Pragma("pop_macro(\"READ\")")`, used in a group
  only C takes) is not looked into, so it leaves a C header with C++ linkage as it is. The check
  relies on `native.analysis-suppression` (RV-PRAESIDIUM-01), which rejects every `_Pragma` and
  `__pragma` wherever it stands, so such a header fails the policy scan instead;
- on Windows hosts the analyzer keeps ending paths at calls named `error`, `panic`, `Assert` and
  the rest of its list (see the analyzer pass), so a returning function of such a name still hides
  the reports on the path after it there;
- on a case-insensitive file system (macOS, Windows), a file the compiler reads through an include
  line spelled in another case (`#include "QUIET.TXT"` for a tracked `src/quiet.txt`) is listed by
  clang under the spelled name, which matches no path Git lists, so the dependency scan does not
  read it in either scope; files in the extension table are read by the policy scan regardless;
- in changed scope, a changed file outside the extension table (or a changed script source) is
  compiled only through configured units that reach an include line that can name it by path,
  directly or through headers: one reached only through a macro-named `#include`, a directory the
  build adds that `praesidium.json` does not list, an include directory reached through a symbolic
  link (`inc` linking to `data`, so the compiler reads `data/body.txt` while the lookup knows only
  `inc`) or spelled out of the checkout and back into it (`../<checkout name>/share`, which the
  lookup skips as outside the repository), another such file or a fragment that includes it (a
  unit's unchanged `x.inc` that includes `<body.txt>`), an include line the index reads raw and so
  does not see as one (a comment before or inside the directive, `/**/#include` or
  `#/**/include`, the digraph `%:include`, a line splice inside the directive, layout other than a
  blank or a tab), a translation unit that another unit includes, or, on Windows, a quoted include
  that clang finds in the directory of a file further up the include stack, is neither compiled nor
  scanned by a PR that changes only it. The whole-repository scope and the next change to a unit
  that includes it scan it. A changed path that holds a backslash fails closed (`error`) in a
  repository with configured units, whether or not a unit is compiled: it may be a fragment or such
  a file, which cannot be matched reliably, since clang lists such a name with a slash there (the
  dependency scan above). A backslash in an include line or an include directory is read both as
  part of a name and as a separator, as on Windows (`#include "a\b.txt"` also names `src/a/b.txt`),
  which only adds units (for that file; they count toward a changed fragment's room, below);
- the units for such a file are matched by name and by ranges, not proven: a header that names it
  is followed to its own includers by name, so a header of the same name elsewhere can select
  extra units, and a unit that lists a directory under which some line names a changed file is
  selected for any matching line it reaches, so a unit whose own compiler reads another file of
  that name can be selected when it lists that directory for another line or another changed file
  (and climbs are matched by their ranges, above). For the file this only adds units; the cost
  is that a defect an extra unit already has fails the change (the same defect fails the
  whole-repository scope), that the extra units count toward the 256-file limit, so such a change
  can end on that limit, as the whole-repository scope of more than 256 units does, and that they
  count toward a changed fragment's room too, so they can make the fragments of the same change
  keep only the units matched by path or directory (above);
- the dependency scan reads the names clang lists, so a path clang cannot list as it is can let a
  listed name stand for another file and leave the file the compiler read unscanned: a backslash
  path inside an initialized submodule (the backslash rule reads only the repository's own
  listing), a repository path that holds a line break, and a checkout whose own path holds a
  backslash beside a copy of it under the slash spelling (the dependency scan above);
- a changed fragment that nothing includes by name (a macro-named `#include` from another
  directory, or a fragment included only by another fragment) and no configured unit sees is not
  compiled, and its includers are matched by the last path component, not proven: a fragment of the
  same name elsewhere selects extra units. When they and the units the change's other files
  select would pass the room the unit limit leaves, the fragment's units are matched by path
  instead (above), with the gaps of a file outside the extension table (a directory the build
  adds that `praesidium.json` does not list, a symbolic link, the other shapes above): a unit that
  reads the fragment only through such a shape is then compiled for it only when it sees the
  fragment by directory.

## RV-PRAESIDIUM-04: Revisor test gate

`praesidium-ci.mjs` wraps the existing `runPlannedTests` at both production call sites:
`review-work.mjs` (queued test stage) and `runner.mjs` (direct/autofix/verification paths).
It emits a named `Praesidium security preflight` CI result **before** setup/install, registered cases
or Augur domain bundles. Failed/error/unrecognized/thrown results prevent those later operations.
The existing `testsPassed` gate blocks the returned failure. A test selector cannot remove this
preflight when the test stage runs. A wholly skipped registered-tests stage does not run it;
the existing mandatory registered-test selection for executable/dependency changes remains intact.
Existing LLM security scan, leakage checks and merge gates are preserved. The built-in preflight
result is added when the updated Revisor runner is deployed. The optional HTTP server only enqueues
jobs: `worker-spawn.mjs` starts `cli.mjs run-worker`, which imports `runner.mjs` and owns the stage
workers. A newly spawned worker reads the merged modules; no server restart is required for this change.

Tests: `test/praesidium-{input,scan,files,ci}.test.mjs`. The repository's npm test script discovers
them, but the live Revisor registry previously selected only `one-shot-runtime-tests`
(`test/process.test.mjs`, `test/codex-runtime.test.mjs`), not the whole npm suite. Therefore #3444's
Test OK is evidence for those existing registered checks, **not** a passing Praesidium regression suite.

The existing `LUDIARS/Revisor` registration was updated through the authenticated registration API
and read back, preserving all four prior cases and notification/workflow settings. Added case:

```json
{
  "name": "praesidium-regression-tests",
  "command": "node",
  "args": ["--test", "test/praesidium-input.test.mjs", "test/praesidium-scan.test.mjs", "test/praesidium-files.test.mjs", "test/praesidium-ci.test.mjs", "test/ui.test.mjs", "test/ui-dashboard-refresh.test.mjs", "test/refactoring-proposal-cache.test.mjs"],
  "cwd": ".", "timeout_ms": 120000, "always": true, "runtime": false
}
```

The C/C++ hardening change (RV-PRAESIDIUM-05) also depends on the change classification that plans
the test stage (`CMakeLists.txt` and other build definitions must reach it) and on the reviewer's
native brief. Their tests are not in this case, so the registration is to add
`test/change-classification.test.mjs`, `test/review-plan.test.mjs` and
`test/reviewer-prompt.test.mjs` to its `args` and read it back. The registry lives in Revisor's
state, so that is an operator step outside the change itself. All three need only Node.

These tests require only Node and Git, not installed npm packages or initialized submodules.
The CI adapter lazily imports the existing dependency-bearing runner only when actually running
registered tests after a passing scan; its injected regression tests never load that runner.
This permits the always-on case to run even for docs-only changes whose dependency setup is skipped.
The registry lives in Revisor's state, not in package.json; recreating a registration must preserve
this named case. Read-back proves registration, not execution. Later review CI results are the
execution evidence; syntax verification alone is not a test pass.

Review #3445 initially stopped in the deployed preflight before registered tests ran.
Read-only collection reproduced `non-text source`: `src/refactoring-proposal-cache.mjs`
contained one literal NUL byte inside the cache-key template literal. Representing that
separator as the JavaScript `\0` escape preserves the runtime key while making the source
text inspectable. The collector still rejects raw NUL bytes; a regression fixture checks
both escaped and raw representations. Passing delegated review remains required.

## RV-PRAESIDIUM-05: Native analysis baseline and the AIFormat C++ conventions

Revisor ships one header, `src/praesidium/native/include/praesidium/baseline.h`. Native analysis
force-includes the running Revisor's copy (`-include`, never the reviewed repository's) into every
pass of every unit. It is an analysis input, not a product header: product builds take their
standard library hardening, warnings and baseline targets from AIFormat's
`cpp/LudiarsCxxBaseline.cmake` (RULE_CODE_CPP §C2.9, §C4.2), which is the single owner of what
ships.

The header declares `strcpy`, `strcat`, `sprintf`, `vsprintf`, `wcscpy` and `wcscat`
(`NATIVE_REJECTED_APIS`; `gets` is already undeclared since C11/C++14) as deprecated, so the
`-Werror` diagnostics pass rejects every use the syntactic rule cannot see: through a macro, a `-D`
alias (the header `#undef`s object-like aliases), `std::` qualification, parentheses or a function
pointer.

It reads nothing before its declarations and leaves no macro behind:

- no `#include`. An include there searched the unit's repository `-I` directories first, so a
  repository file named like a standard header (`include/cstring`, `stddef.h`, or `features.h`
  reached through libstdc++) ran inside the baseline and could define the macro that skipped it,
  rename its attribute (`#define deprecated nodiscard`, `#define __attribute__(x)`) or set
  `__USE_FORTIFY_LEVEL`; it also defined library macros and selected library features before the
  unit's first line, which broke valid units (`#define _POSIX_C_SOURCE 200112L`, `_GLIBCXX_DEBUG`,
  a file-scope `index` in C++, `#define NULL 0` in C, a C23 unit's own `unreachable`). The
  declarations use compiler builtin types only (`__builtin_va_list`; `wchar_t` in C++,
  `__WCHAR_TYPE__` in C, the types glibc's and Apple's headers typedef from) and `__restrict`, and
  the attribute is spelled with reserved names (`[[__deprecated__(...)]]` in C++,
  `__attribute__((__deprecated__(...)))` in C). They come before the C library's, whose later,
  compatible declaration inherits the attribute; C++ re-exports the names into `std` (the standard
  library's later `using` declarations repeat them);
- the exception specification matches the C library's, since a mismatch is a hard error in either
  order: glibc declares these functions `noexcept(true)` in C++ (its `__THROW`). `__GLIBC__` is
  defined only by `features.h`, which has not run, so glibc is recognized by
  `__has_include(<gnu/libc-version.h>)`, a header only it ships, which is not read. musl, Apple's
  libc and the BSD libcs declare no exception specification and get none; a real-clang test checks
  such a library (`-nostdinc` with a library header declared without one) still compiles and still
  rejects `strcpy`. A C library that declares one and is not recognized makes every C++ unit that
  includes its declarations fail to compile: fail closed, never a silent skip. A repository header
  named `gnu/libc-version.h` can only change the answer on a non-glibc host, where at worst it makes
  units fail to compile;
- `#pragma once` instead of a guard macro, and every helper macro `#undef`'d at the end, so no
  `PRAESIDIUM_` macro or library macro is defined when the unit starts: `#ifndef
  PRAESIDIUM_BASELINE_H`, `#ifndef NULL` or `#ifndef EOF` take the same branch under analysis as in
  the product build (each hid a use-after-free from the gate); a real-clang test checks every
  macro the header defines. Only definitions can reach the baseline, and praesidium.json may not
  define the names it spells (RV-PRAESIDIUM-03). Its declarations themselves stay visible: in C++ a
  requires-expression on one of the six names can tell analysis from a product build of a unit that
  includes no C library header (a documented gap, RV-PRAESIDIUM-03).

Analysis never optimizes, so glibc's `_FORTIFY_SOURCE` wrappers are absent; were they present,
they are definitions after the deprecated declarations and inherit the attribute. Windows is left
to the UCRT, which already deprecates these functions and declares them `dllimport` or defines them
inline; a unit that defines `_CRT_SECURE_NO_WARNINGS` turns that off, and the syntactic rule still
rejects direct calls there. A C++20 module unit must open with its module declaration and cannot
take a force-include, so its analysis runs without the baseline (policy rules still apply).

Revisor's own `praesidium.json` declares `test/fixtures/praesidium-native/bounded_apis.{c,cpp}`
(bounded formatting and copies, results checked), whose `includes` make the baseline visible to
them. A change to the header is therefore analyzed by its header jobs: it tests `__cplusplus`, so it
is compiled once with each unit's configuration (C17 and C++20), after the running Revisor's copy,
which is a different file in the gate (with a guard macro, the running copy had hidden the reviewed
one, and a broken header passed). A real-clang test compiles both fixtures against the header in
C11/C17/C23 and C++17/20/23/2c, together with the feature-macro units above.

An earlier draft of this change also shipped product-side pieces from Revisor: a C++23 `safe.hpp`
(narrow, checked arithmetic, bounded copies and formatting, a byte reader), a zero-filling global
`operator new` replacement, always-on standard library hardening and a `Praesidium::baseline` CMake
target. Compared with AIFormat they duplicated or contradicted its rules, so they were removed
(decision of 2026-11-08) and handed to AIFormat as a proposal: C++20 is the LUDIARS default and C++23
features need checking on four toolchains first (§C1.7); hardening is limited to debug, test and
sanitizer presets and applied per build, not per target (§C2.9; mixing hardened and unhardened
copies of an inline function lets the linker silently keep the unchecked one); `narrow`,
`ByteReader`/`take_bytes` and `Expected` belong in `ergo/common` with non-template checks (§C2.3,
§C5.1); and `LudiarsCxxBaseline.cmake` is the build baseline.

AIFormat's proposals to Revisor (RULE_CODE_CPP "Revisor への提案"), as of this change:

1. Extending the banned APIs (`strncpy`, `strtok`, scanf family, `atoi` family, `std::sto*`,
   `alloca`, `rand`): `alloca` is in (`native.stack-allocation`) and unbounded scanf conversions are
   in (`native.unbounded-scan`). The rest stay with AIFormat's change-set gate (`cpp-build-policy`):
   Praesidium's policy rules scan the whole repository, so one existing use blocks every PR of that
   repository (Odeum has six `std::sto*` calls). Decision of 2026-11-08.
2. Non-literal `snprintf` formats are rejected in analyzed units by the diagnostics pass
   (`-Wformat=2`). `LoadLibrary(A|W)` stays with AIFormat's change-set gate for the same reason.
3. Header coverage is implemented as automatic header jobs (RV-PRAESIDIUM-03) rather than a
   `covers` list.
4. `optin.taint` is not added: the checker names differ between clang releases and an unknown name
   fails every unit.
5. `cplusplus` (with `NewDelete*`) is named explicitly in the checker set.

None of this makes C++ memory safe. Compiler and linker hardening (`_FORTIFY_SOURCE`, stack
protector, control-flow integrity, ASLR), sanitizers and fuzzing remain the build's and the tests'
responsibility.

## Melpomene replacement decision

Ars-Musa inspected at `5b4ebe28ab7afe46968bf4f140f5fc965b5edb73`:
`melpomene/src-tauri/src/lib.rs` registers issue CRUD/comments, scene/position ticket lookup,
notification/PR/review/workflow queries, milestones and configuration. Its TypeScript API exposes
these operations. The optional Rust web server currently exposes only `/api/health`, not a security scanner.
`docs/DESIGN.md` §4-D describes QA/bug tracking; planned Actio/Nuntius links are not treated as verified.
Praeforma has an ars-musa project but no matching retrieved security spec; Anatomia has no ars-musa
registry entry. Inspection therefore used the local implementation and specs without registering a project.

UnityFoundation `spec/tools/Musa.md` and `spec/code/Debug/Melpomene{,Runtime}.md` additionally document
the Musa editor tab, SceneView ticket UI and a separate in-game bug-report form (GitHub/direct relay).
These are different responsibilities and are not supplied by this tool. Replacing Melpomene wholesale
would remove user-facing features; no replacement/deletion/rename is performed. Praesidium remains
a separate preventive tool. Current usage or redundancy has not been proven, so retirement is not inferred.

## Evidence / limits

Revisor baseline `b743f60`: existing `security-scan.md`, `review-gate.md`, `ci.mjs`,
`review-work.mjs`, `runner.mjs`. Anatomia context returned these review-gate/CI entry points;
its ontology/cache warnings mean persistence was not verified. Praeforma project
`01M3FVMG4SGXX9V4XN4VAKJ2DP` was read; no matching security feature was returned in that listing.
The new specification here is the implementation contract, not a retroactive assertion of approval.

Native analysis (RV-PRAESIDIUM-03/05), measured with clang 18.1.3 on glibc (Ubuntu 24.04):

- Odeum at `427becf`, every one of its 115 units and 113 headers in the changed set (host packages
  removed, so units that need them fail the same way before and after): 227 checks with identical
  status before and after the review fixes (92 passed, 134 failed on missing packages and submodule
  sources, 1 `error` for the known `amf0.cpp` compiler crash), the same not-analyzed
  ScreenCaptureKit header (it fails the preprocessing probe), no finding from the dependency
  scan (the failing units' lists included) or the expansion pass, and the same unit and the same
  arguments for every job (685 compiler processes, also with every tracked file in the changed
  set). The same holds with `core.builtin.NoReturnFunctions` disabled, and in the
  whole-repository scope (115 units). 85 to 95 s per full run: one preprocessing process per file
  (at most 2.9 MB of output for an Odeum unit) is within run-to-run noise.
- Policy rules over the 2,828 policy sources (244 of them native) of the local repositories
  (Odeum, castra, aiformat, Revisor and six more) and the 4,148 native files under `/usr/include`
  (4,006) and `/usr/lib/gcc` (142; two files that are not UTF-8 or over 2 MiB are not read): the
  same 425 findings before and after (one in the repositories: castra's existing
  `web.dynamic-code` hit). None of the repositories tracks a `.inc`, `.def`, `.C` or `.M` file, so
  no longer collecting fragments and reading `.C` and `.M` by their configured standard (every
  reading when unconfigured) change nothing there. A whole-repository scan of each gives the same
  report before and after. Of the 818 `.h` files under `/usr/include` whose language turns on
  `__cplusplus`, 682 hold only C++ linkage (compiled as C++ only where C++ reads them) and 136 are
  compiled in both languages, among them those with a definition, `#undef` or include in a
  language group (`inttypes.h` defines `__gwchar_t` as `wchar_t` for C++ only). Five of the 136
  differ from a C header with C++ linkage only in what C++ reads besides the code C reads:
  glibc's `string.h`, `strings.h` and `wchar.h` test a macro their C++ group defines to pick C++
  overloads, and freetype's `fterrors.h` and `ftmoderr.h` test and `#undef` one.
  `linux/keyctl.h` (a member only C reads inside a struct) and `X11/Xalloca.h` (an empty macro
  only C defines, used inside parentheses only C reads) hold only C++ linkage. Over the wider host
  tree (`/usr/lib/gcc`, clang's resource headers, and the Ruby and Node.js include trees under
  `/opt`; 12,981 native files), counting depths where macros are used and per branch and skipping
  `#if 0` keep 16 headers with only C++ linkage that would otherwise be compiled in both languages
  (freetype's `ftheader.h`, CPython's `pycore_critical_section.h`, Ruby's `onigmo.h`, `regex.h`
  and `robject.h` copies). The local repositories have no header with only C++ linkage.
- Each review reproduction was run before and after; every fix has a regression test in the test
  files that fails when the fix is reverted (the targeted reverts of the review rounds, 315 in
  all, each turned at least one test red on the code of their round, apart from three: one
  restores a backtracking directive head that the line split already makes harmless, one gives
  every node of the changed paths' trees a map, which stays linear and only costs time, 1.1 s
  instead of 0.35 s for 10,000 changed files 200 levels deep, and one asks for a single file's
  real path with the JavaScript `realpathSync` instead of the system's, which also only costs
  time, since a collection resolves each directory once either way).
- Header language selection, the include index, unit visibility and the include-directory lookup,
  the expansion scan, the probe's Objective-C test, the dependency list parser and the resolution
  of the names it lists stay linear: 2 MiB
  adversarial inputs (nested `#if`, `#else` and `#elif` chains, `#if 0` floods, `#if !defined(` and
  `extern "C"` floods, definitions, includes and pragmas in language groups, runs of code only C
  reads with members, checks, empty macros in parentheses and pragma operators, pairs and chains of
  groups that repeat their conditions or fail to, with long conditions and `#elif` floods, a
  directive line holding a CR with 2 MiB of blanks or of a masked comment after its `#`, long
  directive and macro names, unclosed parameter lists, brace, parenthesis, digraph and linkage-macro
  floods, brace macros used a million times or called after long blanks, chains of definitions and
  of macros built from linkage macros, two million empty lines, each with LF, CR LF, LF CR and
  lone-CR line ends, unclosed `[[` and `__attribute__((`, linemarker and pragma floods, unterminated
  raw strings and raw strings holding linemarkers, `#include "` without an end, include lines
  spelling 2 MiB of path components, of `./`, of backslashes or of `../` in one line or in 1,180
  lines that each climb one level more, quoted include lines in a directory 1,900 levels deep,
  runs of backslashes and `$$`) take at most about 1 s each on
  a loaded host, the masking of the 2 MiB header included (up to 0.8 s of it for long names and
  `#if` floods). Include spellings and include directories are normalized in one pass
  (posix.normalize read its result again at each leading `..`, so one line and one directory
  climbing 60,000 levels took 6.7 s). A quoted include line is resolved from its source's
  directory, found once per source, and spelled paths are kept only as far as the changed paths
  hold them: 2 MiB of distinct quoted names in a directory 1,900 levels deep take about 0.2 s with
  a changed file beside them and 0.15 s with a changed header elsewhere (10 s when each line
  rebuilt its source's path; four such headers ran out of memory), and 15 headers of 2 MiB that
  spell distinct ten-component paths take about 0.45 s for an unrelated change (out of memory when
  every spelled component was kept). The changed paths' two trees keep an unbranched run of
  components without a map per component, so 10,000 changed files each 200 levels deep take about
  0.35 s (1.1 s with a map per component). A spelling or an include directory that holds a
  backslash is read both ways, which at most doubles what it costs: 2 MiB of quoted spellings that
  each hold nine backslashes take about 0.15 s, 1,180 lines that each climb one level more with
  `..\` about 0.25 s, and three units that each list 30,000 directories written with a backslash
  about 0.35 s. The include index is built only when a header changes, a fragment changes or some
  line can name a changed file; for those 15 headers (950,000 distinct names in 30 MiB) it takes
  about 1.1 s, and for 16 headers of 2 MiB that hold 2.2 million of the shortest distinct include
  lines (32 MiB, the most one run collects) about 3.5 s with a changed header and 4.1 s with a
  changed file one line names, about 0.25 s per 2 MiB header (0.55 s when neither changes; the
  policy rules take about 6.7 s on the same input). Choosing the units for changed files takes at
  most about 0.4 s for 30,000 changed files one unit includes, 16,000 changed files named in one
  unit and found through a directory 16,000 units list, 4,000 changed headers and as many fragments
  that 4,000 units see, 20,000 changed headers of one name, 6,000 changed files named at the end of
  a 6,000-header chain (also 12,000 of them each in its own unit's directory), 14,000 changed files
  each named in a header one of 14,000 units includes, all of them listing the directory, 30,000
  changed files in the 30,000 directories each of three units lists (or 20,000 in directories other
  units list, the line's unit listing 40,000 others), 20,000 changed files or fragments each named
  by one header of a 20,000-header chain (also with the unit listing the headers' own directory),
  6,000 changed files each named by one header of a 6,000-header chain in another of the unit's
  directories, 500 changed files named across a layered graph of 10,000 headers that 20 units
  listing their directory reach, 8,000 changed files one header names that 8,000 units include,
  8,000 changed files one line of 8,000 headers names in 8,000 directories, and 29,000 changed files
  in listed directories that one 2 MiB header spells after each of 1,180 climbs; and at most about
  0.7 s for 32,000 changed files or fragments along a 32,000-header chain, 29,000 changed files each
  quoted by one header of a 29,000-header chain in the directory the unit lists, 32,000 changed
  files one header names that 32,000 units include, and 29,000 changed files in the 34,000
  directories each of three units lists. Each of these took seconds to minutes, or ended on a lookup
  bound, when every file read every unit, a unit's every include line or directory or every climb of
  a spelling, or a chain was walked once per header or per directory. Past the unit limit, matching
  a changed fragment by path as well takes about 0.35 s for 29,000 units in 9,700 libraries whose
  public headers each include their own generated fragment. Checking 30,000 configured units against
  the tracked files takes about 50 ms. The dependency scan resolves 300 listed headers 1,000
  directories deep, with 300 `.txt` files beside them that it reads, in 0.2 to 0.3 s (about 7 s when
  each name was resolved whole, the system reading it again at each component, and 16 s when Git
  was asked which of the files it tracks once per 8,000 bytes of names, each call walking the
  deep directories), 300 names that climb back with `..` at as many depths of that chain in about
  0.2 s, and 1,000 such names in a 2 MB list in about 0.28 s (4.9 s and 14 to 16 s when a directory
  reached again through a `..` or a link was asked again with everything below it), and 1,000
  `.txt` files 1,900 directories deep, about all a 4 MiB list holds, in about 0.55 to 3.4 s,
  nearly all of it the system walking those deep paths, so the figure follows the host's cost per
  path component at that depth (measured between about 160 and 590 ns on the same machine type):
  about 280 s with a Git call per 8,000 bytes, and the whole CLI run on that repository takes about
  2.5 to 10.5 s instead of 390 s. The resolution reads each name's components once, apart from the
  whole path of each newly reached directory, which the process builds and hashes and which grows
  with its depth as the system's own walk does. What the system does for it is not linear either:
  it is asked for each directory by its whole path the first time and resolves a link's target
  whole, so 100 ignored chains 600 directories deep with one listed file each take about 1.4 s
  (2.2 s before), and 1,000 links into the depths of one chain 1,000 deep, each read through to a
  file at its end, take 6 to 10 s (as before); both grow with the square or the cube of the depth,
  not with the list.
  Collection resolves each directory once per run too: 1,000 headers 900 directories deep take
  about 0.5 s (20 s when each file's real path was asked of the system whole), and 1,000 headers
  1,900 directories deep (a 3.8 MB listing) about 2 s, 0.55 s of it Git's listing and most of the
  rest the system walking each file's whole path a few times (about 157 s before). Each directory
  a resolver reaches keeps its whole path, so 200 separate chains 500 directories deep with one
  header each hold about 240 MB (about 60 MB before) and take about 8.5 s, 6.7 s of it Git's own
  listing walk, as before. Each invocation still resolves its unit's file and include directories
  with the system's real path, whole, so a unit 1,900 directories deep costs about 0.25 to 1 s per
  invocation, depending on the host (at most 256 invocations), as before. A repository path that
  holds a backslash ends the scan once a unit is compiled, with no search (searching the names
  that hold one took 2.6 s for 1,000 listed names under 900 nested directories that each held one).
  A directive is read by its name and the rest of its line, with no regular expression that can
  backtrack over its blanks. The policy rules take at most about 1 s on 2 MiB inputs built against the
  header-name exemption (chains of exempted `<`, names and `$` runs before a `'`), trigraphs,
  named UCNs, member `alias(` calls, gsl scopes split by directives, and `eval` before blank runs
  or masked comments; masking a 2 MiB header in its readings is most of that (about 0.3 s per
  reading), and a source without a `'` is read once for C17 and C23 (2 MiB of `\N{` in a header
  took 1.5 to 1.9 s in three readings, 0.8 s in two).
- Limits: the baseline's glibc detection and exception specification were verified on glibc only;
  a library without an exception specification was simulated (`-nostdinc`), and an unrecognized one
  fails closed. Disabling the analyzer's exit-handler list was measured on Linux only; Windows
  hosts keep it, from the UCRT's declaration of `_wassert`, without a Windows run. The documented
  gaps are listed at the end of RV-PRAESIDIUM-03.

Primary references:
- https://clang.llvm.org/docs/ClangStaticAnalyzer.html
- https://clang.llvm.org/docs/analyzer/checkers.html
- https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

Policy rule limits (RV-PRAESIDIUM-01), besides the aliases, macros and indirect calls every
syntactic tripwire misses:

- `native.analysis-suppression` sees `suppress` only where the word itself stands inside an
  attribute specifier. Reached through a macro alias (`#define QUIET suppress`, or
  `#define S clang::suppress` used as `[[S]]`), an argument of a macro that pastes it into one, or a
  configured define, the word is invisible to a syntactic rule; the expansion pass finds the
  attribute after macro expansion in analyzed files (RV-PRAESIDIUM-03), the only files where it
  can hide a report. Flagging `suppress` on every `#define` line would reject ordinary macros with
  a parameter named `suppress`. A `suppress` word after an attribute opener that never closes is
  rejected for the rest of the file. The rule does not track `#if` state, so an opener whose two
  brackets a skipped group of code separates (`[` + `#if 0` + `x` + `#endif` + `[clang::suppress]]`)
  is not one to it; the expansion pass reads that too. Only the qualified `gsl::suppress` is let
  through, and only with no directive line between `gsl` and `suppress`:
  `[[using gsl: suppress("type.1")]]`, which the analyzer also ignores, and a gsl one split by a
  directive are rejected.
  `__INCLUDE_LEVEL__` and `__BASE_FILE__` are rejected in units too (a `__BASE_FILE__` in a log
  message, say), where analysis and the product build agree on them.
- `native.symbol-alias` reads only literal symbols: a symbol a macro supplies
  (`__asm__(NAME(strcpy))`, a stringized name, a pragma whose tokens a macro expands) is not
  read, and an asm statement that names such a symbol in its text for another reason (a comment in
  the assembly) is rejected. A symbol alias the build supplies (`-Wl,--defsym`, a linker script) is
  outside source rules. A variable named `alias` initialized with such a name
  (`std::string alias("popen");`) is rejected like the attribute.
- `native.trigraph` rejects `??/` inside a comment that it neither ends nor continues in a C file,
  a header, or a `.C` or `.M` that is not configured with a C++ standard, although it changes
  nothing there, and a C++ header (`.hpp`) or an unconfigured `.C` or `.M` is read as C17 too, so
  `'????'` there is rejected although no C++ standard Praesidium accepts has trigraphs. The C17
  reading of such a file also takes a digit separator's `'` for the start of a character literal,
  which can end in a comment and leave its text as code: `return 1'000; // don't use strcpy(d, s)`
  in a `.hpp` is rejected as `native.unbounded-copy`. Configuring a `.C` or `.M` with its C++
  standard reads it as C++ alone. A C++ build that enables trigraphs (`-trigraphs`, or ISO C++14 and
  older, which a unit cannot declare) is outside the rule. `native.named-ucn` rejects a valid
  named UCN in an identifier too (`caf\N{LATIN SMALL LETTER E WITH ACUTE}`), which `\u00e9`
  spells as well. None of the corpus below has either.
- Besides `analyzer_noreturn`, clang's analyzer ends every path at a call to a global C function
  with one of a fixed list of names (`exit`, `panic`, `error`, `Assert`, `__assert_fail` and others)
  whether or not the callee returns: glibc's `error(0, ...)` returns, and a use after free behind
  it went unreported. No syntactic rule can reject calls to `error`; the analyzer pass disables the
  `core.builtin.NoReturnFunctions` checker instead (functions declared `noreturn` still end paths
  through the CFG), except on Windows hosts, where it remains a documented gap (RV-PRAESIDIUM-03).
  The price, accepted on purpose, is that a glibc `error(EXIT_FAILURE, ...)` guard no longer ends
  its path, so the code after it must end the path itself (the analyzer pass, RV-PRAESIDIUM-03).
- MSVC `#pragma warning(disable: 4996)`, which clang honors on `*-windows-msvc` targets and which
  turns off the UCRT deprecations the Windows analysis relies on, is not rejected: `#pragma warning`
  is left to AIFormat RULE_CODE_CPP §C9.4 (RV-PRAESIDIUM-01). Only its operator form
  `__pragma(warning(...))` is rejected, because clang macro-expands `__pragma`.
- `native.ambiguous-header-name` fails closed: `#if X < 3 // a -> b` is rejected, because the comment
  hides the `>` a header-name reading would end at; rewording the comment resolves it. Every
  `#pragma` line is read, so one with a quote between `<` and `>` (`#pragma mark - a < b, it's > c`,
  or a C23 digit separator in `#pragma omp parallel for if(n < 1'000 && m > 2)` in a `.c` or `.h`
  file) is rejected too: a pragma's own tokens may matter, so the `#if` exemption does not apply
  there. The rule rejects no line in the 244 native sources of ten local LUDIARS repositories or in
  the 4,148 native files under `/usr/include` (4,006) and `/usr/lib/gcc` (142), and neither do
  `native.symbol-alias`, `native.trigraph` and `native.named-ucn`.
- The call rules take a function-pointer declarator named like an API (`int (*system)(const char*)`)
  or a condition on a variable named like one before a parenthesized statement
  (`if (system) (void)0;`) for a call, as `native.unbounded-copy` always has, and a declaration of
  the API by name (`int system(const char*)`) for a use. None of the corpus above has either shape.
- The JS/TS masker does not recognize regular-expression literals (RV-PRAESIDIUM-01). An
  unterminated string of 8 MiB, four times the file limit, exhausts its stack; the inspection then
  fails closed.

## UI test integration correction

The next review of #3445 reached all 349 files and rejected 12 dynamic-code calls
in existing UI tests. Following explicit human approval, UI views, actions, filters,
client requests and dashboard lifecycle are ordinary exported functions. Browser
source is serialized from these same functions; behavioral tests import them directly.
Syntax-only checks use node:vm Script compilation without invoking a run method.
No source-policy exclusions or weaker detection rules are introduced.
The registered Praesidium case also includes UI, dashboard-refresh and cache regression
files so these changes receive delegated execution. Local checks are syntax-only.
