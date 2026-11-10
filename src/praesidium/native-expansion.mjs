/** @implements RV-PRAESIDIUM-03 — preprocessed output: the analyzer's suppress attribute, read where the compiler reads it (after macro expansion), and the probe's Objective-C test. */
import { maskNativeCode } from "./native-lexer.mjs";

// The expansion pass prints the analyzed file preprocessed (`-E`): macros expanded,
// comments removed, trigraphs replaced. A linemarker starts each run of lines
// (`# 12 "src/a.h" 1 3`, or `#line 12 "src/a.h"` on MSVC-compatible targets); flag 3
// marks a system header. The output is bounded like any compiler output.
export const EXPANSION_LIMIT = 64 * 1024 * 1024;
const LINEMARKER = /^#(?:line)?[ \t]+(\d+)[ \t]+"((?:[^"\\]|\\.)*)"([ \t\d]*)\r?$/;
// The other directive lines clang prints (`#pragma`, `#ident`) carry no attribute the
// analyzer applies, but their tokens (`#pragma omp parallel [[`) could open or close one.
// clang prints every directive with its `#` in the first column (a digraph as `#`), and a
// `#` token of code that starts a line after a space, so only a first-column `#` is one.
const DIRECTIVE_LINE = /^#/;
// A raw string literal is the one token that spans lines in the output; clang prints its
// prefix and quote together (`R"`, `u8R"`), splices removed.
const RAW_STRING_PREFIX = 'R"';
const MASKED_RAW_STRING = /R"[^"]*"/g;
// A run of system-header text inside repository code: no attribute contains it.
const SYSTEM_TEXT = "\0";
// `[[`, `[ [` (digraphs read as brackets) and the GNU keyword in both spellings.
const OPENER = /\[\s*\[|\b__attribute(?:__)?\s*\(\s*\(/g;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|::|[()[\]]|\0/g;
const SUPPRESS = /^(?:__)?suppress(?:__)?$/;
// The C++ Core Guidelines spelling, which the analyzer ignores (MSVC's code analysis reads it).
const IGNORED_SCOPE = "gsl";

/** The lexical rules of the language a pass names with `-x` and `-std=`. */
export function expansionLexing(args) {
  const cxx = (args[args.indexOf("-x") + 1] ?? "").includes("++");
  return { rawStrings: cxx, digitSeparators: cxx || args.includes("-std=c23"), moduleImports: cxx };
}

// clang writes a linemarker's file name escaped (`\\`, `\"`, `\t`, octal bytes).
function linemarkerPath(escaped) {
  const bytes = escaped.replace(/\\(?:([0-7]{3})|(.))/g, (_, octal, character) =>
    octal ? String.fromCharCode(parseInt(octal, 8)) : ({ n: "\n", t: "\t" }[character] ?? character));
  return Buffer.from(bytes, "latin1").toString("utf8");
}

/**
 * Offsets in masked code where an attribute names the analyzer's suppress at the top
 * level of its list: `[[clang::suppress]]` (any scope but gsl, or a `using` prefix) and
 * `__attribute__((suppress))`. An argument (`cleanup(suppress)`) is another name, and an
 * unscoped `[[suppress]]` is an unknown attribute the diagnostics pass already rejects
 * (and, in Objective-C, a message send). System text inside an attribute counts as a
 * hit: nothing valid includes a header there. Linear: each token is read once.
 */
export function suppressAttributeOffsets(code) {
  const opener = new RegExp(OPENER), token = new RegExp(TOKEN), offsets = [];
  for (let open; (open = opener.exec(code));) {
    token.lastIndex = opener.lastIndex;
    const words = [];
    let depth = 0, end = code.length;
    for (let next; (next = token.exec(code));) {
      const text = next[0];
      if (text === SYSTEM_TEXT) offsets.push(next.index);
      else if (text === "(" || text === "[") depth++;
      else if (text === ")" || text === "]") {
        if (depth-- === 0) { end = token.lastIndex; break; }
      } else if (depth === 0) words.push(next);
    }
    offsets.push(...suppressNames(words, open[0][0] !== "["));
    opener.lastIndex = end;
  }
  return offsets.sort((a, b) => a - b);
}

function suppressNames(words, gnu) {
  const prefix = !gnu && words[0]?.[0] === "using" ? words[1]?.[0] : null;
  return words.flatMap((word, index) => {
    if (!SUPPRESS.test(word[0])) return [];
    if (gnu) return [word.index];
    const scope = words[index - 1]?.[0] === "::" ? words[index - 2]?.[0] : prefix;
    return scope && scope !== IGNORED_SCOPE ? [word.index] : [];
  });
}

/**
 * Whether preprocessed text holds Objective-C syntax: an `@` outside every literal, which
 * no C or C++ token contains (`@interface`, `@class`, `@"..."`, `@import`). The directive
 * lines clang prints (`#pragma`, `#ident`) are not code, so an `@` there does not count.
 */
export function holdsObjectiveC(text, lexing) {
  return maskNativeCode(text, { ...lexing, logical: true }).split("\n").some(line => !DIRECTIVE_LINE.test(line) && line.includes("@"));
}

/**
 * Where the preprocessed text of one analyzed file applies the analyzer's suppress
 * attribute outside system headers, as `{ path, line }` (the path as the linemarker
 * names it, the line in that file). An alias, a macro argument, a paste or a configured
 * define reaches the attribute only through expansion, which this reads.
 */
export function expandedSuppressions(text, lexing) {
  const { lines, tail, breaks, segments } = scanLines(text.split("\n"), lexing);
  const view = lines.join("\n");
  // The lines before `tail` are still unmasked; those from it on were masked together.
  const head = lines.slice(0, tail).join("\n");
  const offsets = suppressAttributeOffsets(maskNativeCode(head, { ...lexing, logical: true }) + view.slice(head.length));
  const found = [];
  let line = 0, at = 0, segment = -1;
  for (const offset of offsets) {
    for (; at < offset; at++) if (view.charCodeAt(at) === 10) line++;
    while (segment + 1 < segments.length && segments[segment + 1].start <= line) segment++;
    const origin = segments[segment] ?? { path: null, line: 1, start: 0 };
    // clang does not count the line breaks inside a raw string, so until its next
    // linemarker it prints each later line that much lower.
    const shift = countBelow(breaks, line) - countBelow(breaks, origin.start);
    found.push({ path: origin.path, line: origin.line + line - origin.start - shift });
  }
  return found;
}

/**
 * The output lines as the scan reads them: a linemarker or another directive line blank,
 * the first line of each system run SYSTEM_TEXT and the rest of the run blank. From the
 * first line of repository text that holds a raw string prefix on (`tail`), a line inside
 * a raw string is text, never a linemarker or a directive, so the lines from there are
 * masked together first and returned masked; the lines before it hold no multi-line token
 * and are returned unmasked. `breaks` lists, in order, the lines whose line break lies
 * inside a raw string. Linear: the tail is masked once.
 */
function scanLines(lines, lexing) {
  const segments = [];
  let system = false, marked = false, tail = lines.length, masked = null, breaks = [];
  for (let index = 0; index < lines.length; index++) {
    if (!masked && lexing.rawStrings && !system && lines[index].includes(RAW_STRING_PREFIX)) {
      ({ masked, breaks } = maskedLines(lines.slice(index), lexing, index));
      tail = index;
    }
    const read = masked ? masked[index - tail] : lines[index];
    const directive = DIRECTIVE_LINE.test(read);
    const marker = directive ? LINEMARKER.exec(lines[index]) : null;
    if (marker) {
      system = marker[3].trim().split(/[ \t]+/).includes("3");
      segments.push({ start: index + 1, line: Number(marker[1]), path: linemarkerPath(marker[2]) });
    }
    if (directive) {
      lines[index] = "";
    } else if (!system) {
      lines[index] = read;
      marked = false;
    } else if (marked || !read.trim()) {
      lines[index] = "";
    } else {
      lines[index] = SYSTEM_TEXT;
      marked = true;
    }
  }
  return { lines, tail, breaks, segments };
}

// Lines masked together, as one text, and split again at the same line breaks; `breaks`
// holds the index (from `first`) of each line whose line break lies inside a raw string.
// Masking keeps a raw string's prefix and closing quote and blanks what lies between, so
// each `R"` up to the next quote in the masked text is one literal (any other literal
// spans no line).
function maskedLines(lines, lexing, first) {
  const source = lines.join("\n");
  const text = maskNativeCode(source, { ...lexing, logical: true });
  const breaks = [];
  let at = 0, line = first;
  for (const literal of text.matchAll(MASKED_RAW_STRING)) {
    for (let inside = literal[0].indexOf("\n"); inside >= 0; inside = literal[0].indexOf("\n", inside + 1)) {
      for (; at < literal.index + inside; at++) if (source.charCodeAt(at) === 10) line++;
      breaks.push(line);
    }
  }
  at = 0;
  return { masked: lines.map(line => text.slice(at, (at += line.length + 1) - 1)), breaks };
}

// How many entries of an ascending list are below `value`.
function countBelow(list, value) {
  let low = 0, high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < value) low = middle + 1; else high = middle;
  }
  return low;
}
