import { isJavaScriptEvaluation } from "./javascript-evaluation.mjs";
import { isNativeSource, isScriptSource, nativeLanguage } from "./languages.mjs";
import { maskNativeCode, SPLICE_MARK } from "./native-lexer.mjs";

/** @implements RV-PRAESIDIUM-01 — bounded syntactic tripwires, not a full parser. */

// C APIs that cannot bound their output. praesidium/baseline.h deprecates the same
// names, so the diagnostics pass also rejects uses this syntactic rule cannot see
// (through macros or function pointers), and a unit may not define these names.
export const NATIVE_REJECTED_APIS = Object.freeze(["gets", "strcpy", "strcat", "sprintf", "vsprintf", "wcscpy", "wcscat"]);
// The Win32 and CRT spellings of the same unbounded copies and formats, and the legacy
// unbounded reads: rejected here only, because they are macros or platform functions the
// portable baseline cannot redeclare. StrCat is left out: absl::StrCat is a safe C++ name.
const NATIVE_UNBOUNDED_ALIASES = ["lstrcpy[AW]?", "lstrcat[AW]?", "wsprintf[AW]?", "wvsprintf[AW]?", "_tcscpy",
  "_tcscat", "_mbscpy", "_mbscat", "_stprintf", "_swprintf", "StrCpy[AW]?", "getwd", "_getws", "_getts"];
// The end of a call. `(strcpy)(d, s)` and `((strcpy))(d, s)` are calls too: the
// parentheses only stop a function-like macro. A run of `)` follows one name only, so
// every call rule stays linear in the file size.
const CALL = String.raw`\s*(?:\)\s*)*\(`;
// The compiler builtins (`__builtin_sprintf`, and the `__builtin___sprintf_chk` that
// _FORTIFY_SOURCE emits) and the glibc entry points those lower to (`__sprintf_chk`,
// `__gets_chk`, which take any size) are the same calls under names the baseline cannot
// redeclare. `_chk` counts only after a reserved `__`, so a wrapper named `strcpy_chk`
// is not a use.
const REJECTED = NATIVE_REJECTED_APIS.join("|");
const UNBOUNDED_NAMES = `${NATIVE_UNBOUNDED_ALIASES.join("|")}|(?:__builtin_)?(?:${REJECTED})|(?:__builtin_)?__(?:${REJECTED})_chk`;
const NATIVE_UNBOUNDED_CALL = new RegExp(String.raw`\b(?:${UNBOUNDED_NAMES})` + CALL, "g");
// The functions of the other call rules below, by name.
const STACK_NAMES = String.raw`alloca|_alloca|__builtin_alloca\w*`;
const COMMAND_NAMES = "system|_wsystem|popen|_popen|_wpopen";
const TEMP_NAME_NAMES = "tmpnam|_tmpnam|_wtmpnam|tempnam|_tempnam|mktemp|_mktemp|_wmktemp";
// Clang's horizontal whitespace inside a directive: \f and \v count like space and tab.
const BLANK = "[ \\t\\f\\v]";
// A banned.h-style header defines or undefines these names to forbid them; that is the
// defense, not a use. Only a short directive prefix qualifies, so the check stays bounded.
const BAN_DIRECTIVE = new RegExp(`^${BLANK}*#${BLANK}*(?:define|undef)${BLANK}+$`);
const BAN_DIRECTIVE_WINDOW = 64;
// scanf-family conversions that write a string of any length: %s, %S, %ls, %[...] and
// their positional forms (%1$s) without a width (and without `*`, which discards the
// field). glibc also reads the `'` and `I` flags before the width, takes a zero width
// (%0s) as none and `q` as a length modifier, so those forms are unbounded too. %ms
// allocates and is bounded. Besides the builtins, glibc's C99 and C23 entry points
// (`__isoc99_sscanf`, which its headers redirect sscanf to) are the same calls. The group
// is the function's name without that prefix.
const SCAN_NAMES = "(?:__builtin_|__isoc99_|__isoc23_)?(scanf|sscanf|fscanf|vscanf|vsscanf|vfscanf|wscanf|swscanf|fwscanf|vwscanf|vswscanf|vfwscanf|_tscanf|_stscanf|_ftscanf)";
const SCAN_CALL = new RegExp(String.raw`\b${SCAN_NAMES}` + CALL, "g");
const FORMAT_FIRST = new Set(["scanf", "vscanf", "wscanf", "vwscanf", "_tscanf"]);
const UNBOUNDED_CONVERSION = /(?<!%)(?:%%)*%(?:\d+\$)?['I]*0*(?:hh|h|ll|l|j|z|t|L|w|q)?(?:s|S|\[)/;
const SCAN_ARGUMENT_LIMIT = 256;
const ARGUMENT_DELIMITER = /[()[\]{},]/g;
const BRACKET = /[()[\]{}]/g;
// In masked code a literal keeps its prefix and quotes and loses its contents. C has no
// raw strings: there `R"..."` is a name (perhaps a macro) followed by a literal, which
// cannot be checked, and a header is read as C too.
const MASKED_LITERAL = /((?:u8|[uUL])?)(R?)"[^"]*"/g;
const ONLY_LITERALS = /^\s*(?:(?:u8|[uUL])?R?"[^"]*"\s*)+$/;
const ONLY_PLAIN_LITERALS = /^\s*(?:(?:u8|[uUL])?"[^"]*"\s*)+$/;
// The masked literals that follow an opener, by whether raw strings exist.
const LITERAL_RUN = { true: /\s*(?:(?:u8|[uUL])?R?"[^"]*"\s*)+/y, false: /\s*(?:(?:u8|[uUL])?"[^"]*"\s*)+/y };
// A line splice as the lexer and clang read one: a backslash, optional blanks and one
// line break (CR LF and LF CR count as one).
const SPLICE_FORM = String.raw`\\[ \t\v\f]*(?:\r\n|\n\r|\n|\r)`;
const SPLICE = new RegExp(SPLICE_FORM, "g");
const SPLICES = new RegExp(`(?:${SPLICE_FORM})*`, "y");
// GNU asm labels (`char *cp(char *, const char *) __asm__("strcpy");`), the weakref and
// alias attributes, Microsoft's `#pragma comment(linker, "/alternatename:cp=strcpy")` and
// `#pragma redefine_extname cp strcpy` bind a declaration to another function's symbol,
// so `cp(d, s)` calls strcpy where neither a call rule nor the baseline's deprecation
// sees it; an asm statement's text can call the symbol too (`__asm__("call strcpy")`).
// A member named alias (`cmd.alias("system")`, `->alias(`) is no attribute.
// The symbol is read from the literals after the opener, the way scan formats are, or
// from the pragma's tokens. A Mach-O `_` prefix or an ELF version (`strcpy@GLIBC_2.2.5`)
// names the same function.
const SYMBOL_ALIAS = new RegExp([
  String.raw`\b(?:asm|__asm|__asm__)\b\s*(?:(?:volatile|__volatile|__volatile__|inline|__inline|__inline__|goto)\b\s*)*\(`,
  String.raw`\b(?:__)?(?:alias|weakref)(?<!(?:\.|->)\s*(?:__)?(?:alias|weakref))(?:__)?\s*\(`,
  String.raw`^${BLANK}*#${BLANK}*pragma${BLANK}+comment${BLANK}*\(${BLANK}*linker${BLANK}*,`,
  String.raw`(?<tokens>^${BLANK}*#${BLANK}*pragma${BLANK}+redefine_extname\b[^\r\n]*)`,
].join("|"), "gm");
const ALIASED_SYMBOL = new RegExp(String.raw`(?<![\w$.])_?(?:${[UNBOUNDED_NAMES, SCAN_NAMES, STACK_NAMES, COMMAND_NAMES, TEMP_NAME_NAMES].join("|")})(?![\w$])`);
// Trigraphs, which clang reads in ISO C before C23 and in ISO C++ before C++17, are
// replaced before comments and literals exist. Three of them move a boundary the masker
// draws: `??/` is a backslash (a line splice or an escape, anywhere, so it is read in the
// source), `??'` a `^` where the masker takes its `'` for a quote (in code, or closing a
// character literal; the view keeps a literal's quotes), and `??=` a `#` that starts a
// directive, which matters only in code. Until the first of them, the masker reads as
// clang does, so each is found where it first matters. The other six only spell
// punctuators no call rule reads. Only the C17 reading has trigraphs: C23 and the C++
// standards Praesidium accepts (C++17 and later) have none.
const TRIGRAPH_BACKSLASH = /\?\?\//g;
const TRIGRAPH_QUOTE = /\?\?'/g;
const TRIGRAPH_HASH = /\?\?=/g;
const trigraphReading = (lexing) => !lexing.digitSeparators;
// `\N{...}`: clang reads an invalid name (`\N{NOPE}`, the abbreviation `\N{NBSP}`) in a
// skipped #if group as the end of a pp-number, while the masker, which has no Unicode name
// table, lets every name of name characters continue one. The logical view keeps every
// named UCN in code except a name of Unicode whitespace (layout there, as for clang).
const NAMED_UCN = /\\ *N *\{/g;
// Source-level switches that make clang drop analyzer reports or warnings for what
// follows: any GNU linemarker (`# 1 "x" 3`; clang macro-expands its file name and flags,
// so `# 1 "x" SYS` can carry the system-header flag too), the system_header pragma (also
// Microsoft's spelling without a namespace) and the diagnostic pragmas, the pragma
// operators `_Pragma` and Microsoft's `__pragma` (whose tokens clang macro-expands, so no
// rule can read their content), [[clang::suppress]] and __attribute__((suppress)) in any
// spelling, a #define or #undef of the name `suppress` itself (or of `gsl`, the one scope
// the analyzer ignores, below), analyzer_noreturn (the analyzer ends every path at a call
// the compiler builds as returning) and code conditioned on __clang_analyzer__. Each does
// what a PR-supplied `-w` or `-isystem` flag would, so it is rejected like one
// (RV-PRAESIDIUM-03). So are __INCLUDE_LEVEL__ and __BASE_FILE__: a header job compiles
// the header as the main file, where they differ from every product build, so code
// conditioned on them could hide from the header job or make it fail on purpose. They
// run on the logical view (splices joined, comments blanked, digraphs read as
// punctuators), the form the preprocessor acts on.
const SUPPRESSION_WORDS = String.raw`\b(?:_Pragma|__pragma|__clang_analyzer__|(?:__)?analyzer_noreturn(?:__)?|__INCLUDE_LEVEL__|__BASE_FILE__)\b`;
const SUPPRESSION_DIRECTIVE = new RegExp([
  String.raw`^${BLANK}*#${BLANK}*\d`,
  String.raw`^${BLANK}*#${BLANK}*pragma${BLANK}+(?:(?:clang|GCC)${BLANK}+)?system_header\b`,
  String.raw`^${BLANK}*#${BLANK}*pragma${BLANK}+(?:clang|GCC)${BLANK}+diagnostic${BLANK}+(?:ignored|warning)\b`,
  String.raw`^${BLANK}*#${BLANK}*(?:define|undef)${BLANK}+(?:(?:__)?suppress(?:__)?|gsl)\b`,
  SUPPRESSION_WORDS,
].join("|"), "gm");
const SUPPRESSION_WORD = new RegExp(SUPPRESSION_WORDS);
// The attribute is found from the rare `suppress` word: it counts inside an attribute
// specifier (attributeSuppressions), at any distance from the specifier's opener, unless
// the gsl scope qualifies it: the analyzer ignores `[[gsl::suppress(...)]]`, the C++ Core
// Guidelines spelling for MSVC's code analysis.
const SUPPRESS_WORD = /\b(?:__)?suppress(?:__)?\b/g;
const SUPPRESS_NAME = /^(?:__)?suppress(?:__)?$/;
const IGNORED_SCOPE = "gsl";
const ATTRIBUTE_NAME = /^__attribute(?:__)?$/;
// The tokens that open, close or name things for that scan: line ends, `#`, brackets,
// words and runs of other punctuation; blanks between them are skipped.
const ATTRIBUTE_TOKEN = /(\r\n?|\n)|(#)|([[\](){}])|(\w+)|[^\s\w[\](){}#]+/g;
const NEXT_OPEN_BRACKET = { code: /\s*\[/y, directive: /[ \t\f\v]*\[/y };
const NEXT_CLOSE_BRACKET = { code: /\s*\]/y, directive: /[ \t\f\v]*\]/y };
const NEXT_OPEN_PAREN = { code: /\s*\(/y, directive: /[ \t\f\v]*\(/y };
const NEXT_OPEN_PARENS = { code: /\s*\(\s*\(/y, directive: /[ \t\f\v]*\([ \t\f\v]*\(/y };
const NEXT_CLOSE_PAREN = { code: /\s*\)/y, directive: /[ \t\f\v]*\)/y };
const CLOSED_BY = { "]": "[", ")": "(", "}": "{" };
// An opener whose second bracket is still to come: directive lines between `[` and `[`,
// or between `__attribute__` and its two `(`, change nothing for clang.
const AFTER_KEYWORD = "__attribute__";
// In #if and #elif clang reads `<...>` as one header name when the tokens before it
// expand to `__has_include (`, which a macro can hide from any lexer, and as tokens
// otherwise; in #embed, #pragma GCC dependency and Microsoft's #pragma include_alias it
// always does. The masker reads a header name only after #include, #include_next, #import
// and a literal `__has_include (`. Where a comment or literal the masker opens inside
// `<...>` runs past the closing `>`, clang may compile code the policy view hides, so
// the line is rejected. Every #pragma line is read: pragma handlers decide on their own
// whether they take a header name.
const HEADER_NAME_DIRECTIVE = new RegExp(`^${BLANK}*#${BLANK}*(?:if|elif|pragma|embed)\\b[^\\r\\n]*`, "gm");
// C17 reads the `'` of a C23 digit separator (`1'000`) as the start of a character
// literal. In #if and #elif, whose tokens only form a condition, a `>` hidden only by one
// is let through when the C17 header-name reading of the rest of the line is inert (see
// inertTail): every C17 reading then ends the line in the same state, and what the
// masker hides there are condition tokens no rule needs.
const CONDITION = new RegExp(`^${BLANK}*#${BLANK}*(?:if|elif)\\b`);
const NUMBER_START = /^\.?\d/;
// The characters a name or a pp-number may hold in the view. A splice inside one, which
// stops a walk over them, is rejected on its own (native.identifier-splice).
const TOKEN_CHARACTER = /[\w.$\u0080-\uffff]/;
// The rest of the line after that `>`, read as tokens: no `'`, `"` or backslash, a `/` that
// is division or opens a block comment closed on the line, then perhaps a `//` comment or a
// character literal that holds no `'` and so runs to the line end.
const TAIL_TOKENS = /^(?:[^'"\\\/\r\n]|\/(?![*\/])|\/\*(?:[^*\\\r\n]|\*(?!\/))*\*\/)*/;
const TAIL_END = /^(?:\/\/[^\\\r\n]*|'[^'\\\r\n]*)?$/;
const TAIL_COMMENT = /\/\*(?:[^*]|\*(?!\/))*\*\//g;
// Keywords, not namespaces, may stand before `::` (`return ::system(cmd)`), and so may
// the GNU keyword operators (`__extension__ ::system(cmd)`).
const NOT_A_NAMESPACE = "std|return|co_return|co_yield|co_await|throw|else|do|case|new|delete|sizeof|and|or|not|xor|bitand|bitor|compl|and_eq|or_eq|xor_eq|not_eq|__extension__|__real__|__imag__|__real|__imag";

const NATIVE_RULES = [
  { rule: "native.unbounded-copy", pattern: NATIVE_UNBOUNDED_CALL, accept: (code, _source, match) => !banDirective(code, match.index) },
  { rule: "native.unbounded-scan", pattern: SCAN_CALL, accept: (code, source, match, context) => unboundedScan(source, code, match, context) },
  // Stack allocation sized at run time: an attacker-chosen size overruns the stack.
  { rule: "native.stack-allocation", pattern: new RegExp(String.raw`\b(?:${STACK_NAMES})` + CALL, "g") },
  // Shell command execution. Members (`.system(`, `->system(`) and names qualified by a
  // namespace other than std are different functions.
  { rule: "native.command-execution",
    pattern: new RegExp(String.raw`(?<!(?:\.|->|\b(?!(?:${NOT_A_NAMESPACE})\b)[A-Za-z_]\w*\s*::)\s*)\b(?:${COMMAND_NAMES})` + CALL, "g") },
  // Predictable temporary names, open to a race between naming and creating the file.
  { rule: "native.insecure-temp-name", pattern: new RegExp(String.raw`\b(?:${TEMP_NAME_NAMES})` + CALL, "g") },
  { rule: "native.symbol-alias", pattern: SYMBOL_ALIAS, accept: (code, source, match, context) => ALIASED_SYMBOL.test(aliasText(code, source, match, context)) },
  // A backslash-newline inside a name joins two lines into one identifier
  // (`str\` + `cpy(`), which no rule above can see.
  { rule: "native.identifier-splice", pattern: new RegExp(`[A-Za-z0-9_]${SPLICE_MARK}+[A-Za-z0-9_]`, "g") },
  { rule: "native.trigraph", pattern: TRIGRAPH_BACKSLASH, view: "source", reading: trigraphReading },
  { rule: "native.trigraph", pattern: TRIGRAPH_QUOTE, view: "source", reading: trigraphReading,
    accept: (code, _source, match) => code[match.index + 2] === "'" },
  { rule: "native.trigraph", pattern: TRIGRAPH_HASH, reading: trigraphReading },
  { rule: "native.named-ucn", pattern: NAMED_UCN, accept: (_code, source, match) => namedUcnAt(source, match.index) },
  { rule: "native.ambiguous-header-name", pattern: HEADER_NAME_DIRECTIVE, accept: (code, source, match) => ambiguousHeaderName(code, source, match) },
  { rule: "native.analysis-suppression", pattern: SUPPRESSION_DIRECTIVE },
  { rule: "native.analysis-suppression", pattern: SUPPRESS_WORD,
    accept: (code, _source, match, context) => (context.attributeWords ??= attributeSuppressions(code)).has(match.index) },
];
const SCRIPT_RULES = [
  // The blanks after `?.` belong to it, so no two `\s*` compete for one run of blanks
  // (`eval` and a long run without a `(` cost the square of its length).
  { rule: "web.dynamic-code", pattern: /\b(?:eval|Function)\s*(?:\?\.\s*)?\(/g, accept: (code, _source, match) => isJavaScriptEvaluation(code, match) },
  { rule: "web.request-to-html", pattern: /\.innerHTML\s*=\s*(?:req|request|ctx|location)\s*[.[]/g },
  { rule: "web.request-to-shell", pattern: /\b(?:exec|execSync)\s*\(\s*(?:req|request|ctx)\s*[.[]/g },
];

// The lexical rules each native language is read with. C has neither raw strings nor
// `import`; C17 has no digit separators but C23 does, and a header, a `.C` or a `.M` may
// be either C or C++, unless `c` says which a configured `.C` or `.M` unit's standard
// declares (true for C, false for C++). A file is masked once per rule set and the findings
// are united, so no reading the compiler might use hides code from the rules.
const C_LEXING = [
  { rawStrings: false, digitSeparators: false, moduleImports: false },
  { rawStrings: false, digitSeparators: true, moduleImports: false },
];
const CXX_LEXING = [{ rawStrings: true, digitSeparators: true, moduleImports: true }];

function nativeLexing(file, c) {
  const { language, either } = nativeLanguage(file);
  if (either && typeof c === "boolean") return c ? C_LEXING : CXX_LEXING;
  if (language === "header" || either) return [...C_LEXING, ...CXX_LEXING];
  return language === "c" || language === "objective-c" ? C_LEXING : CXX_LEXING;
}

// Keep newlines/offsets so a finding never needs to retain source text or secrets.
// Script sources only: C/C++ literals need maskNativeCode (native-lexer.mjs). Every
// alternative ends at its closing token, at a line end (quoted strings) or at the end of
// input, so it always matches once opened: an unterminated opener is consumed once
// instead of being rescanned from every later position (a file of repeated `/* ` took
// minutes). A block comment or template that finds no closer (often an opener inside a
// regular-expression literal, which this masker does not recognize) is masked only to
// its line end. No later opener of that kind can close either: there is no `*/` after
// the first, and every later backtick was an escaped character of the first template,
// which leaves the same escapes after it. So from then on that kind ends at the line end,
// like a quoted string, and the scan stays linear.
const SCRIPT_QUOTED = String.raw`\/\/[^\r\n]*|"(?:\\[\s\S]?|[^"\\\r\n])*(?:"|(?=[\r\n])|$)|'(?:\\[\s\S]?|[^'\\\r\n])*(?:'|(?=[\r\n])|$)`;
const SCRIPT_COMMENT = [String.raw`\/\*[\s\S]*?(?<comment>\*\/|$)`, String.raw`\/\*[^\r\n]*`];
const SCRIPT_TEMPLATE = [String.raw`\`(?:\\[\s\S]?|[^\`\\])*(?<template>\`|$)`, String.raw`\`(?:\\[^\r\n]?|[^\`\\\r\n])*\`?`];
// Indexed by commentToLineEnd + 2 * templateToLineEnd.
const SCRIPT_TOKENS = [0, 1, 2, 3].map((mode) =>
  new RegExp(`${SCRIPT_COMMENT[mode & 1]}|${SCRIPT_QUOTED}|${SCRIPT_TEMPLATE[mode >> 1]}`, "g"));

export function maskCommentsAndLiterals(source) {
  let mode = 0, out = "", last = 0, pattern = SCRIPT_TOKENS[0], match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(source))) {
    let text = match[0];
    const unclosed = match.groups?.comment === "" ? 1 : match.groups?.template === "" ? 2 : 0;
    if (unclosed) {
      const lineEnd = text.search(/[\r\n]/);
      if (lineEnd >= 0) text = text.slice(0, lineEnd);
      mode |= unclosed;
      pattern = SCRIPT_TOKENS[mode];
    }
    out += source.slice(last, match.index) + text.replace(/[^\r\n]/g, " ");
    last = match.index + text.length;
    pattern.lastIndex = last;
  }
  return out + source.slice(last);
}

function banDirective(code, index) {
  const from = Math.max(0, index - BAN_DIRECTIVE_WINDOW);
  const window = code.slice(from, index);
  const lineBreak = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("\r"));
  if (lineBreak < 0 && from > 0) return false;
  return BAN_DIRECTIVE.test(window.slice(lineBreak + 1));
}

// C escape sequences, so `"%\x73"` is read as the `%s` the compiler sees.
function decodeEscapes(text) {
  return text.replace(/\\(?:x([0-9A-Fa-f]+)|([0-7]{1,3})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/g,
    (_match, hex, octal, short, long, other) => {
      if (other !== undefined) return other;
      const code = parseInt(hex?.slice(-6) ?? octal ?? short ?? long, hex || short || long ? 16 : 8);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

// The text of the string literals in the masked range [from, to), read as the compiler
// reads it. Literal text comes from the source at the masked literal's offsets (the
// masker keeps the quotes): an ordinary literal loses its line splices before its escapes
// are decoded (translation phase 2 comes first), and a raw string keeps its text between
// the delimiter's parentheses as written. Nothing of it is retained in a finding.
function literalText(source, code, from, to) {
  let text = "";
  for (const literal of code.slice(from, to).matchAll(MASKED_LITERAL)) {
    const quote = from + literal.index + literal[1].length + literal[2].length;
    const body = source.slice(quote + 1, from + literal.index + literal[0].length - 1);
    text += literal[2] ? body.slice(body.indexOf("(") + 1, body.lastIndexOf(")")) : decodeEscapes(body.replace(SPLICE, ""));
  }
  return text;
}

// Whether a scanf-family call at `match` may write an unbounded string: its format
// argument is not made only of string literals (a macro or variable cannot be checked),
// or the literals, read as the compiler reads them, contain an unbounded conversion.
function unboundedScan(source, code, match, context) {
  const { lexing } = context;
  const position = FORMAT_FIRST.has(match[1]) ? 0 : 1;
  const argument = callArgument(code, match.index + match[0].length, position, context.bracketEnds ??= bracketEnds(code));
  if (!argument) return true;
  const masked = code.slice(argument[0], argument[1]);
  if (!(lexing.rawStrings ? ONLY_LITERALS : ONLY_PLAIN_LITERALS).test(masked)) return true;
  return UNBOUNDED_CONVERSION.test(literalText(source, code, argument[0], argument[1]));
}

// What a symbol alias at `match` names: the literals right after its opener (none when
// something else follows, such as a macro), or the tokens of a redefine_extname pragma.
// Each opener reads only the literals that follow it, so the rule stays linear.
function aliasText(code, source, match, context) {
  if (match.groups.tokens !== undefined) return match.groups.tokens;
  const from = match.index + match[0].length;
  const run = LITERAL_RUN[context.lexing.rawStrings];
  run.lastIndex = from;
  return run.test(code) ? literalText(source, code, from, run.lastIndex) : "";
}

// Whether the backslash at `backslash` starts `\N{`, read across splices as the lexer reads it.
function namedUcnAt(source, backslash) {
  const name = afterSplices(source, backslash + 1);
  return source[name] === "N" && source[afterSplices(source, name + 1)] === "{";
}

// The [start, end) offsets of argument `position` of the call whose arguments start at
// `open`, or null when its end lies beyond the bounded walk (SCAN_ARGUMENT_LIMIT
// characters). The walk jumps from delimiter to delimiter and over each nested bracket
// pair at once, so a call costs only its own top-level delimiters before that argument,
// and the rule stays linear even when every call opens another one inside it.
function callArgument(code, open, position, ends) {
  const limit = Math.min(code.length, open + SCAN_ARGUMENT_LIMIT);
  let index = 0, start = open;
  ARGUMENT_DELIMITER.lastIndex = open;
  for (let found; (found = ARGUMENT_DELIMITER.exec(code)) && found.index < limit;) {
    const at = found.index, character = code[at];
    if (character === "(" || character === "[" || character === "{") {
      if (ends[at] < 0 || ends[at] >= limit) return null;
      ARGUMENT_DELIMITER.lastIndex = ends[at] + 1;
    } else if (character === ",") {
      if (index === position) return [start, at];
      index++;
      start = at + 1;
    } else return index === position ? [start, at] : null;
  }
  return null;
}

// For each opening bracket of the view, the offset of the closer that ends it, or -1. Any
// closer ends the innermost open bracket, as a depth count would. One pass with a stack.
function bracketEnds(code) {
  const ends = new Int32Array(code.length).fill(-1);
  const open = [];
  BRACKET.lastIndex = 0;
  for (let found; (found = BRACKET.exec(code));) {
    const character = found[0];
    if (character === "(" || character === "[" || character === "{") open.push(found.index);
    else if (open.length) ends[open.pop()] = found.index;
  }
  return ends;
}

// Index just past the line splices that start at `index`, or `index`.
function afterSplices(source, index) {
  SPLICES.lastIndex = index;
  SPLICES.test(source);
  return SPLICES.lastIndex;
}

const isLineBreak = (character) => character === "\n" || character === "\r";

// The offset of the `>` that ends a header name opened at `open`, or of the line break
// (or `end`) that leaves it unterminated, read as clang's LexAngledStringLiteral reads
// one: across splices, and skipping each escaped character, so `<a\>/*b>` ends at the
// second `>`.
function headerNameEnd(source, open, end) {
  let at = afterSplices(source, open + 1);
  while (at < end && source[at] !== ">" && !isLineBreak(source[at])) {
    if (source[at] === "\\") {
      at = afterSplices(source, at + 1);
      if (at >= end || isLineBreak(source[at])) break;
    }
    at = afterSplices(source, at + 1);
  }
  return at;
}

// Whether a directive line holds a `<` token whose header-name reading ends at a `>`
// the masker hid: the comment or literal hiding that `>` is code if clang reads a header
// name there. A header name ends at its first unescaped `>` on its physical line (splices
// joined); without one, that reading is a compile error. A `>` read as part of the `:>`
// digraph is a bracket, not hidden. A `<` let through as a C23 comparison does not end the
// check: the code after the literal that hides its `>` may hold a header name of its own.
// Each scan resumes where the last one stopped, so the check is linear in the line.
function ambiguousHeaderName(code, source, match) {
  const end = match.index + match[0].length;
  const condition = CONDITION.test(match[0]);
  for (let at = match.index; at < end; at++) {
    if (source[at] !== "<" || code[at] === " ") continue;
    const close = headerNameEnd(source, at, end);
    if (source[close] === ">" && code[close] === " " && code[close - 1] !== "]"
        && !(condition && separatorLiteral(code, at, close) && inertTail(source.slice(close + 1, end)))) return true;
    at = close;
  }
  return false;
}

// Whether the hidden `>` at `close` lies in a character literal opened by the `'` right
// after a pp-number. A closing quote follows the blanked contents of its literal (or the
// opening quote), never a visible number, so that `'` opens the literal. The token before
// the `'` is found by walking back over every character a name or a number may hold: it is
// a pp-number only when it starts with a digit (or `.` and a digit) and holds no `$`, which
// only a name holds (`$1` and `é1` are names). The walks stay between `at` and `close`.
function separatorLiteral(code, at, close) {
  let quote = close - 1;
  while (quote > at && code[quote] === " ") quote--;
  if (code[quote] !== "'") return false;
  let start = quote;
  while (start > at && TOKEN_CHARACTER.test(code[start - 1])) start--;
  const token = code.slice(start, quote);
  return NUMBER_START.test(token) && !token.includes("$");
}

// Whether the rest of a #if line after a header name, `tail` (the source up to the end of
// the logical line), reads the same in every C17 reading. It holds no line break, so the
// masker, whose literal from the `'` ends at the next `'` or the line end, leaves no block
// comment open past it. Read as tokens after the header name, it ends in the state the
// line started in: TAIL_TOKENS, then TAIL_END. A `<` outside its comments with a `>` after
// it on the line might open a header name of its own, which would read a comment opener or
// a quote in between as plain text, so such a tail may hold neither; without a later `>`
// that `<` is a punctuator in every reading. And it names no word the suppression rule
// rejects, since the masker may hide those tokens.
function inertTail(tail) {
  const tokens = TAIL_TOKENS.exec(tail)[0];
  const rest = tail.slice(tokens.length);
  if (!TAIL_END.test(rest) || SUPPRESSION_WORD.test(tail)) return false;
  const open = tokens.replace(TAIL_COMMENT, (comment) => " ".repeat(comment.length)).indexOf("<");
  return open < 0 || !tail.includes(">", open + 1) || (!rest && !tokens.includes("/*"));
}

// The offsets of the `suppress` words that stand inside an attribute specifier,
// `[[ ... ]]` or `__attribute__(( ... ))` in any spacing (the logical view reads `<:<:` as
// `[[`), at any depth: a function-like macro can move the word into parentheses. One
// pass with a bracket stack, so no distance between the opener and the word (a long
// comment is a long blank run) hides it, and the scan is linear. A directive line keeps a
// stack of its own, so a `]` in a `#define` does not close the attribute around it; the
// attributes a directive leaves open (`#define ATTR __attribute__((`) stay open after it,
// and directive lines between the two brackets of an opener leave it an opener. A word
// the gsl scope qualifies (`gsl::suppress`) is not the analyzer's attribute.
function attributeSuppressions(code) {
  const words = new Set();
  const outside = newStack("code");
  let stack = outside, lineStart = true;
  ATTRIBUTE_TOKEN.lastIndex = 0;
  for (let token; (token = ATTRIBUTE_TOKEN.exec(code));) {
    const [text, lineEnd, hash, bracket, word] = token;
    let next = token.index + text.length;
    if (lineEnd) {
      if (stack !== outside) leaveDirective(stack, outside);
      stack = outside;
      lineStart = true;
      continue;
    }
    if (hash && lineStart) stack = newStack("directive");
    lineStart = false;
    const { pending, recent } = stack;
    stack.pending = null;
    if (bracket) next = bracketToken(code, stack, bracket, next, pending);
    else if (word && ATTRIBUTE_NAME.test(word)) next = attributeKeyword(code, stack, next);
    else if (word && stack.attributes > 0 && SUPPRESS_NAME.test(word) && !(recent[1] === "::" && recent[0] === IGNORED_SCOPE)) {
      words.add(token.index);
    }
    stack.recent = [recent[1], text];
    ATTRIBUTE_TOKEN.lastIndex = next;
  }
  return words;
}

// A frame per open bracket: `[`, `(`, `{`, or `[[` / `((` for an attribute specifier.
// `pending` is the first half of an opener that the stack's next token may complete, and
// `recent` the stack's last two tokens.
const newStack = (mode) => ({ frames: [], attributes: 0, mode, pending: null, recent: [] });

function pushFrame(stack, frame) {
  stack.frames.push(frame);
  if (frame.length === 2) stack.attributes++;
}

// The index after the code or directive form of `pair` matched at `index`, or -1.
function follows(code, pair, stack, index) {
  const pattern = pair[stack.mode];
  pattern.lastIndex = index;
  return pattern.test(code) ? pattern.lastIndex : -1;
}

// Opens or closes a frame and returns where the scan resumes. A closer ends the frame on
// top only if it matches it; `]]` and `))` end an attribute specifier. An opener whose
// halves directive lines separate (`[` + `#if 1` + `#endif` + `[`) is completed by the
// stack's next token; the frame of its first half becomes the specifier's.
function bracketToken(code, stack, bracket, after, pending) {
  if (bracket === pending && stack.frames.at(-1) === bracket) {
    stack.frames[stack.frames.length - 1] = bracket + bracket;
    stack.attributes++;
    return after;
  }
  if (bracket === "[" || (bracket === "(" && pending === AFTER_KEYWORD)) {
    const end = follows(code, bracket === "[" ? NEXT_OPEN_BRACKET : NEXT_OPEN_PAREN, stack, after);
    pushFrame(stack, end < 0 ? bracket : bracket + bracket);
    if (end < 0) stack.pending = bracket;
    return Math.max(end, after);
  }
  if (bracket === "(" || bracket === "{") {
    pushFrame(stack, bracket);
    return after;
  }
  const open = CLOSED_BY[bracket];
  const top = stack.frames.at(-1);
  if (top !== open && top !== open + open) return after;
  stack.frames.pop();
  if (top === open) return after;
  stack.attributes--;
  return Math.max(follows(code, bracket === "]" ? NEXT_CLOSE_BRACKET : NEXT_CLOSE_PAREN, stack, after), after);
}

function attributeKeyword(code, stack, after) {
  const end = follows(code, NEXT_OPEN_PARENS, stack, after);
  if (end >= 0) pushFrame(stack, "((");
  else stack.pending = AFTER_KEYWORD;
  return Math.max(end, after);
}

// The attribute specifiers a directive leaves open, with what is open inside them,
// continue in the code after it. The code's last two tokens do not: a directive between
// `gsl` and `::suppress` (an `#if 0` group around `gsl`, an `#include` of `, clang`) can
// change what clang reads there, so a gsl scope counts only without one in between.
function leaveDirective(directive, outside) {
  const first = directive.frames.findIndex((frame) => frame.length === 2);
  if (first >= 0) for (const frame of directive.frames.slice(first)) pushFrame(outside, frame);
  outside.recent = [];
}

// Line numbers come from the source, where a lone CR also ends a line (as it does for the
// compiler), so a finding inside a joined logical line keeps its physical line.
function lineLocator(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "\n" || (character === "\r" && source[index + 1] !== "\n")) starts.push(index + 1);
  }
  const lineOf = (offset) => {
    let low = 0, high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1; else high = middle;
    }
    return low;
  };
  // The offsets [start, end) of a line `lineOf` returned.
  lineOf.span = (line) => [starts[line - 1], starts[line] ?? Infinity];
  return lineOf;
}

// A directive anchored at its logical line start reports the line of its `#`, not that
// of a comment or splice the logical view joined in front of it. No other match starts
// with a blank, and the leading blanks of separate matches never overlap.
function tokenOffset(match) {
  let offset = 0;
  while (/[ \t\f\v]/.test(match[0][offset] ?? "")) offset++;
  return match.index + offset;
}

// `context` carries the reading's lexical rules and what a rule computes once per view.
// A rule reads the masked view unless it reads the source itself (`view: "source"`), and
// applies in every reading unless `reading` limits it to some.
function ruleMatches(code, source, rules, record, context) {
  for (const { rule, pattern, accept, view, reading } of rules) {
    if (reading && !reading(context.lexing)) continue;
    for (const match of (view === "source" ? source : code).matchAll(pattern)) {
      if (accept && !accept(code, source, match, context)) continue;
      if (!record(rule, tokenOffset(match))) return false;
    }
  }
  return true;
}

/**
 * The policy findings in one source. `c`, for a `.C` or `.M` that praesidium.json configures
 * as a unit, is the language its standard declares (true for C, false for C++): it is then
 * read in that language's readings only, as the extension decides for every other file.
 */
export function sourceFindings(file, source, c = undefined) {
  const native = isNativeSource(file);
  if (!native && !isScriptSource(file)) return [];
  const lineOf = lineLocator(source);
  const seen = new Set(), recent = new Map();
  const findings = [];
  // Already failing at the cap; never turn truncated output into a pass. A match on the
  // line a rule last reported is skipped before the line is looked up. That saves only a
  // constant factor (about a third on 2 MiB of calls on one line): without it each match
  // costs one binary search in lineOf, and `seen` drops the repeat.
  const record = (rule, offset) => {
    const span = recent.get(rule);
    if (span && offset >= span[0] && offset < span[1]) return true;
    const line = lineOf(offset);
    recent.set(rule, lineOf.span(line));
    const key = `${rule}\0${line}`;
    if (seen.has(key)) return true;
    seen.add(key);
    findings.push({ rule, file, line, severity: "high" });
    if (findings.length < 200) return true;
    findings.push({ rule: "inspection.finding-limit", file, line, severity: "high" });
    return false;
  };
  if (!native) {
    ruleMatches(maskCommentsAndLiterals(source), source, SCRIPT_RULES, record, {});
    return findings;
  }
  for (const lexing of distinctReadings(nativeLexing(file, c), source)) {
    if (!ruleMatches(maskNativeCode(source, { ...lexing, logical: true }), source, NATIVE_RULES, record, { lexing })) break;
  }
  return findings;
}

// The C17 and C23 readings differ only where a `'` may be a digit separator, so a source
// without any `'` is masked alike in both, and the C17 reading, which also runs the
// trigraph rules, finds all the C23 one would: it is read once.
function distinctReadings(readings, source) {
  if (source.includes("'") || !readings.some(lexing => !lexing.rawStrings && !lexing.digitSeparators)) return readings;
  return readings.filter(lexing => lexing.rawStrings || !lexing.digitSeparators);
}
