/** @implements RV-PRAESIDIUM-01 — C/C++ comment and literal masking that follows the language's lexical rules. */

// A regular expression cannot mask C/C++ correctly: digit separators (1'000), raw
// strings (R"d( " )d"), header names (<a/*b>) and a stray apostrophe (#error don't)
// each made the previous masker swallow real code, hiding dangerous calls from the
// policy rules. This scanner forms the same comment and literal boundaries as the
// compiler. Literals other than raw strings and block comments end at the line end
// (an unterminated one is ill-formed), so a stray quote never hides later lines.
// Runs in linear time: every character is visited a bounded number of times.
//
// The lexical rules differ by language: raw strings and `import <header>` exist only in
// C++, digit separators only in C++14 and C23. A C file lexed with C++ rules can hide
// code behind `R"(` or `1'0'`, so callers pass the language's options.
//
// Tokens are read as clang reads them. A line splice is a backslash, optional blanks,
// then one line break (CR LF and LF CR count as one), and every token is read across
// splices. pp-numbers and identifiers go on through universal character names and
// non-ASCII characters, and Unicode whitespace separates tokens. The text of `#error`,
// `#warning` and `#pragma mark` is read raw to the end of the logical line, so a quote or
// a `/*` in it opens nothing.
//
// `logical` produces the view the policy rules read: each logical line on one physical
// line, as the preprocessor sees it. Line splices (also inside literals, header names
// and digraphs) and the line breaks inside block comments become spaces (a directive
// continues across both), digraphs read as their punctuators (`%:` as `#`, `<:` `:>` as
// brackets), a splice inside a name becomes SPLICE_MARK so that rule can still see it,
// and layout other than a space or a tab (`\v`, `\f` and Unicode whitespace, raw or as a
// UCN) becomes spaces. Every view keeps the source's length, so an offset in the view is
// the same offset in the source.

const IDENTIFIER = /[A-Za-z0-9_$\u0080-￿]/;
const ASCII_IDENTIFIER = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const PP_NUMBER = /[0-9A-Za-z_.]/;
const SEPARATED = /[0-9A-Za-z_]/;
const EXPONENT = /[eE]/;
const BINARY_EXPONENT = /[pP]/;
const HEX_PREFIX = /[xX]/;
const UCN_HEX = /[0-9A-Fa-f]/;
const UCN_NAME = /[A-Z0-9 -]/;
// The names of clang's Unicode whitespace characters; clang 18 rejects their abbreviations
// (NBSP), and U+0085 is a control character, which no UCN may name.
const WHITESPACE_NAMES = new Set(["NO-BREAK SPACE", "OGHAM SPACE MARK", "MONGOLIAN VOWEL SEPARATOR",
  "EN QUAD", "EM QUAD", "EN SPACE", "EM SPACE", "THREE-PER-EM SPACE", "FOUR-PER-EM SPACE",
  "SIX-PER-EM SPACE", "FIGURE SPACE", "PUNCTUATION SPACE", "THIN SPACE", "HAIR SPACE",
  "LINE SEPARATOR", "PARAGRAPH SEPARATOR", "NARROW NO-BREAK SPACE", "MEDIUM MATHEMATICAL SPACE",
  "IDEOGRAPHIC SPACE"]);
const WHITESPACE_NAME_LIMIT = 32;
// clang's Unicode whitespace: layout between tokens, never part of a name or a number.
const UNICODE_WHITESPACE = /[\u0085\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
// clang stops reading a UCN whose value would no longer fit in 32 bits.
const UCN_OVERFLOW = 0x10000000;
const STRING_PREFIXES = new Set(["L", "u", "U", "u8"]);
const RAW_PREFIXES = new Set(["R", "LR", "uR", "UR", "u8R"]);
const HEADER_DIRECTIVES = new Set(["include", "include_next", "import"]);
// Directives whose text clang reads raw (Lexer::ReadToEndOfLine); `#pragma mark` is the other.
const MESSAGE_DIRECTIVES = new Set(["error", "warning"]);
const HAS_INCLUDE = new Set(["__has_include", "__has_include_next"]);
const RAW_DELIMITER_LIMIT = 16;
const RAW_DELIMITER_CHAR = /[^\s()\\]/;

const isNewline = (ch) => ch === "\n" || ch === "\r";
const isBlank = (ch) => ch === " " || ch === "\t" || ch === "\v" || ch === "\f";
const isLayout = (ch) => isBlank(ch) || (ch > "\x7f" && UNICODE_WHITESPACE.test(ch));

// Every `)delim"` terminator in the source, by delimiter, in ascending order. Built
// once, so finding a raw string's end never rescans the file per literal.
function rawTerminators(source) {
  const byDelimiter = new Map();
  for (let quote = source.indexOf('"'); quote >= 0; quote = source.indexOf('"', quote + 1)) {
    for (let length = 0; length <= RAW_DELIMITER_LIMIT && quote - length - 1 >= 0; length++) {
      const at = quote - length - 1;
      if (source[at] === ")") {
        const delimiter = source.slice(at + 1, quote);
        const list = byDelimiter.get(delimiter) ?? [];
        list.push(at);
        byDelimiter.set(delimiter, list);
      }
      if (length < RAW_DELIMITER_LIMIT && !RAW_DELIMITER_CHAR.test(source[quote - length - 1] ?? "")) break;
    }
  }
  return byDelimiter;
}

function firstAtOrAfter(list, position) {
  let low = 0, high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < position) low = middle + 1; else high = middle;
  }
  return low < list.length ? list[low] : -1;
}

export const SPLICE_MARK = "\u0001";

export function maskNativeCode(source, { rawStrings = true, digitSeparators = true, moduleImports = true, logical = false } = {}) {
  const out = source.split("");
  const length = source.length;
  // Raw strings exist only in C++, so they mark the C++ reading.
  const cxx = rawStrings;
  let terminators = null;
  let lineHasToken = false;

  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (isNewline(source[k])) lineHasToken = false;
      else out[k] = " ";
    }
  };
  // The contents of an ordinary literal or header name, or a directive's raw text. A line
  // break inside one belongs to a splice (the literal ends at any other), so it does not
  // end the logical line: the next token is not the first on its line, and the logical
  // view blanks the line break as it blanks any splice.
  const blankLiteral = (from, to) => {
    for (let k = from; k < to; k++) {
      if (logical || !isNewline(source[k])) out[k] = " ";
    }
  };
  // Layout other than a space or a tab, in the logical view: spaces, which every rule reads
  // as layout (`\s` misses U+0085 and U+180E, `[ \t]` misses the rest, and U+2028 and
  // U+2029 end a line for `^`).
  const markLayout = (from, to) => {
    if (!logical) return;
    for (let k = from; k < to; k++) if (source[k] !== "\t") out[k] = " ";
  };
  // The index after the layout character, or the UCN of Unicode whitespace, at `index`; or -1.
  const layoutEnd = (index) => {
    if (index >= length) return -1;
    if (isLayout(source[index])) return index + 1;
    const ucn = source[index] === "\\" ? readUcn(index) : null;
    return ucn?.kind === "space" ? ucn.end : -1;
  };
  // Blank a block comment. Its line breaks do not end a directive, so the logical view
  // drops them; the token state is the one from before the comment.
  const blankComment = (from, to, hadToken) => {
    for (let k = from; k < to; k++) {
      if (!isNewline(source[k]) || logical) out[k] = " ";
    }
    lineHasToken = hadToken;
  };
  // Index just past the line splices that start at `index`, or `index`. As clang reads a
  // splice (getEscapedNewLineSize): blanks may separate the backslash from the line
  // break, and CR LF or LF CR is one line break.
  const splice = (index) => {
    let k = index;
    for (;;) {
      if (source[k] !== "\\") return k;
      let j = k + 1;
      while (isBlank(source[j])) j++;
      if (!isNewline(source[j])) return k;
      k = j + (isNewline(source[j + 1] ?? "") && source[j + 1] !== source[j] ? 2 : 1);
    }
  };
  const next = (index) => splice(index + 1);
  // Layout, splices and block comments between the tokens of a directive head.
  const skipLayout = (index) => {
    let k = index;
    for (;;) {
      const spliced = splice(k);
      if (spliced !== k) { markSplice(k, spliced); k = spliced; continue; }
      const layout = layoutEnd(k);
      if (layout >= 0) { markLayout(k, layout); k = layout; continue; }
      if (source[k] === "/" && source[next(k)] === "*") {
        const end = commentEnd(next(k) + 1);
        blankComment(k, end, lineHasToken);
        k = end;
        continue;
      }
      return k;
    }
  };
  // A splice in the logical view: spaces, or SPLICE_MARK when it joins two name characters.
  const markSplice = (from, to) => {
    if (!logical) return;
    const joins = IDENTIFIER.test(source[from - 1] ?? "") && IDENTIFIER.test(source[to] ?? "");
    for (let k = from; k < to; k++) out[k] = joins ? SPLICE_MARK : " ";
  };
  // Every splice inside a token that was read across them, from `from` to `to`.
  const markSplices = (from, to) => {
    if (!logical) return;
    for (let k = from; k < to;) {
      const spliced = splice(k);
      if (spliced === k) k++;
      else { markSplice(k, spliced); k = spliced; }
    }
  };
  // A two-character punctuator in the logical view: its spelling, then spaces through its
  // second character, so a splice between the two is blanked with the token. Returns the
  // index after it.
  const punctuator = (index, spelling) => {
    const second = next(index);
    out[index] = spelling;
    for (let k = index + 1; k <= second; k++) out[k] = " ";
    return second + 1;
  };
  // The end of a block comment: a `*` followed by `/`, possibly with splices between.
  const commentEnd = (from) => {
    for (let star = source.indexOf("*", from); star >= 0; star = source.indexOf("*", star + 1)) {
      const after = next(star);
      if (source[after] === "/") return after + 1;
    }
    return length;
  };
  // A universal character name at `backslash`, read across splices as clang's tryReadUCN
  // reads it, or null when it is incomplete (clang then reads the backslash alone):
  // `\uXXXX`, `\UXXXXXXXX`, `\u{X...}` or `\N{...}`. Its `kind` is "char" when it continues
  // an identifier or a pp-number (U+00A0 or above, neither a surrogate nor Unicode
  // whitespace), "space" for Unicode whitespace, and "other" for one clang reads as an
  // unknown token of its own. The last result is kept, since a pp-number or identifier
  // that stops at a UCN leaves the main loop to read the same one.
  let ucnAt = -1, ucnRead = null;
  const readUcn = (backslash) => {
    if (backslash !== ucnAt) { ucnAt = backslash; ucnRead = scanUcn(backslash); }
    return ucnRead;
  };
  const scanUcn = (backslash) => {
    let k = splice(backslash + 1);
    const kind = source[k];
    if (kind !== "u" && kind !== "U" && kind !== "N") return null;
    k = splice(k + 1);
    const braced = source[k] === "{";
    if (braced) k = splice(k + 1);
    if (kind === "N") return braced ? namedUcn(k) : null;
    if (braced && kind === "U") return null;
    const digits = braced ? Infinity : kind === "u" ? 4 : 8;
    let value = 0, count = 0, end = -1;
    while (count < digits && UCN_HEX.test(source[k] ?? "")) {
      if (value >= UCN_OVERFLOW) return null;
      value = value * 16 + parseInt(source[k], 16);
      count++;
      end = k + 1;
      k = splice(k + 1);
    }
    if (braced) {
      if (count === 0 || source[k] !== "}") return null;
      end = k + 1;
    } else if (count < digits) return null;
    if (value < 0xa0 || (value >= 0xd800 && value <= 0xdfff)) return { end, kind: "other" };
    return { end, kind: value <= 0xffff && UNICODE_WHITESPACE.test(String.fromCharCode(value)) ? "space" : "char" };
  };
  // `\N{...}` from just after its brace. Like clang, it runs to its `}` on the line whatever
  // it holds, so a `/*` or a quote inside it opens nothing. A name of Unicode whitespace is
  // a "space". Other names cannot be checked without the Unicode name table, so any name
  // spelled with name characters is a "char". The last scan is kept: a line of repeated
  // `\N{` is read once. Only the name after the last non-name character can be spelled
  // with name characters alone, so the scan keeps just that one (`tail`, bounded).
  let names = { from: -1, until: -1, close: -1, other: -1, tail: "" };
  const namedUcn = (from) => {
    if (from < names.from || from >= names.until) {
      let k = from, other = -1, tail = "";
      while (k < length && source[k] !== "}" && source[k] !== "\0" && !isNewline(source[k])) {
        if (!UCN_NAME.test(source[k])) { other = k; tail = ""; }
        else if (tail.length <= WHITESPACE_NAME_LIMIT) tail += source[k];
        k = next(k);
      }
      names = { from, until: k + 1, close: source[k] === "}" ? k : -1, other, tail };
    }
    if (names.close <= from) return null;
    const end = names.close + 1;
    if (names.other >= from) return { end, kind: "other" };
    return { end, kind: WHITESPACE_NAMES.has(names.tail) ? "space" : "char" };
  };
  // The end of what continues an identifier or a pp-number beyond ASCII at `index`: a
  // universal character name or a non-ASCII character other than Unicode whitespace.
  const extendedEnd = (index) => {
    const at = source[index] ?? "";
    if (at === "\\") {
      const ucn = readUcn(index);
      return ucn?.kind === "char" ? ucn.end : -1;
    }
    return at > "\x7f" && !UNICODE_WHITESPACE.test(at) ? index + 1 : -1;
  };
  // The end of the identifier character at `index`, or -1. It also decides where a word
  // starts, so a word always takes at least one character.
  const wordCharEnd = (index) => ASCII_IDENTIFIER.test(source[index] ?? "") ? index + 1 : extendedEnd(index);
  // An identifier that may continue across splices and through universal character names.
  const readWord = (index) => {
    let k = index, word = "";
    while (k < length) {
      const c = splice(k);
      const end = wordCharEnd(c);
      if (end < 0) break;
      if (c !== k || end !== c + 1) markSplices(k, end);
      word += source.slice(c, end);
      k = end;
    }
    return { word, end: k };
  };
  // The end of the pp-number at `start`, read as clang's LexNumericConstant reads it, across
  // splices: the body [0-9A-Za-z_.]; a sign after a body e or E, or after p or P in C or
  // in a C++ hexadecimal number; a digit separator before an ASCII identifier character;
  // and the extended characters above. A sign, a separator or an extended character
  // restarts the body, so a sign never directly follows one of them.
  const numberEnd = (start) => {
    const hex = source[start] === "0" && HEX_PREFIX.test(source[next(start)] ?? "");
    let k = start + 1, previous = "";
    for (;;) {
      const c = splice(k), at = source[c] ?? "";
      let end = -1;
      if (PP_NUMBER.test(at)) end = c + 1;
      else if (at === "+" || at === "-") {
        if (EXPONENT.test(previous) || (BINARY_EXPONENT.test(previous) && (!cxx || hex))) end = c + 1;
      } else if (at === "'") {
        const separated = splice(c + 1);
        if (digitSeparators && SEPARATED.test(source[separated] ?? "")) end = separated + 1;
      } else end = extendedEnd(c);
      if (end < 0) return k;
      previous = PP_NUMBER.test(at) ? at : "";
      k = end;
    }
  };
  // Ordinary string or character literal, or a header name (close '>'). Masks the contents
  // and returns the index after it.
  const quoted = (open, close) => {
    let k = next(open);
    while (k < length && !isNewline(source[k])) {
      if (source[k] === close) {
        blankLiteral(open + 1, k);
        return k + 1;
      }
      if (source[k] === "\\") {
        // An escape, also in a header name (clang's LexAngledStringLiteral skips one, so
        // `<a\>/*b>` is one name): `k` is past any splice, so this backslash is not one.
        // The escaped character may follow splices (`\\` + newline + `b` reads `\b`); a
        // line break or the end of input there leaves the literal unterminated.
        const escaped = splice(k + 1);
        k = escaped >= length || isNewline(source[escaped]) ? escaped : next(escaped);
      } else k = next(k);
    }
    blankLiteral(open + 1, k);
    return k;
  };
  // The text of `#error`, `#warning` or `#pragma mark` from `from`, which clang reads raw to
  // the end of the logical line: masked like a literal's contents. Returns the line end.
  const rawText = (from) => {
    let k = splice(from);
    while (k < length && !isNewline(source[k])) k = next(k);
    blankLiteral(from, k);
    return k;
  };

  let i = 0;
  while (i < length) {
    const ch = source[i];
    if (isNewline(ch)) { lineHasToken = false; i++; continue; }
    const spliced = splice(i);
    if (spliced !== i) { markSplice(i, spliced); i = spliced; continue; }
    const layout = layoutEnd(i);
    if (layout >= 0) { markLayout(i, layout); i = layout; continue; }
    const ucn = ch === "\\" ? readUcn(i) : null;
    const first = !lineHasToken;
    lineHasToken = true;

    if (ch === "/" && source[next(i)] === "/") {
      // A line comment continues over backslash-newline splices.
      let k = i;
      while (k < length && !isNewline(source[k])) k = next(k);
      blankComment(i, k, !first);
      i = k;
      continue;
    }
    if (ch === "/" && source[next(i)] === "*") {
      const stop = commentEnd(next(i) + 1);
      blankComment(i, stop, !first);
      i = stop;
      continue;
    }
    const digraph = ch === "%" && source[next(i)] === ":";
    if ((ch === "#" || digraph) && first) {
      // A directive: an include-style header name is a literal, not code, and the text of
      // `#error`, `#warning` or `#pragma mark` is not tokens.
      if (digraph && logical) punctuator(i, "#");
      const { word, end } = readWord(skipLayout(digraph ? next(i) + 1 : i + 1));
      if (HEADER_DIRECTIVES.has(word)) {
        const k = skipLayout(end);
        if (source[k] === "<") { i = quoted(k, ">"); continue; }
      }
      if (MESSAGE_DIRECTIVES.has(word)) { i = rawText(end); continue; }
      if (word === "pragma") {
        const pragma = readWord(skipLayout(end));
        if (pragma.word === "mark") { i = rawText(pragma.end); continue; }
      }
      i = digraph ? next(i) + 1 : i + 1;
      continue;
    }
    if (logical && digraph) { i = punctuator(i, "#"); continue; }
    if (logical && ch === "<" && source[next(i)] === ":") {
      // `<::` followed by neither `:` nor `>` is `<` then `::` in C++.
      const third = next(next(i));
      if (!(source[third] === ":" && source[next(third)] !== ":" && source[next(third)] !== ">")) {
        i = punctuator(i, "["); continue;
      }
    }
    if (logical && ch === ":" && source[next(i)] === ">") { i = punctuator(i, "]"); continue; }
    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(source[next(i)] ?? ""))) {
      const end = numberEnd(i);
      markSplices(i, end);
      i = end;
      continue;
    }
    if (wordCharEnd(i) >= 0) {
      const { word, end: k } = readWord(i);
      // An encoding prefix's quote may follow splices too.
      const quote = splice(k);
      if (rawStrings && RAW_PREFIXES.has(word) && source[quote] === '"') {
        markSplice(k, quote);
        let open = quote + 1;
        while (open < length && open - quote - 1 <= RAW_DELIMITER_LIMIT && RAW_DELIMITER_CHAR.test(source[open])) open++;
        if (source[open] === "(" && open - quote - 1 <= RAW_DELIMITER_LIMIT) {
          terminators ??= rawTerminators(source);
          const delimiter = source.slice(quote + 1, open);
          const close = firstAtOrAfter(terminators.get(delimiter) ?? [], open + 1);
          if (close >= 0) {
            const end = close + delimiter.length + 2;
            blank(quote + 1, end - 1);
            lineHasToken = true;
            i = end;
            continue;
          }
        }
        // Malformed or unterminated: mask to the line end only, never the rest of the file.
        i = quoted(quote, '"');
        continue;
      }
      if (STRING_PREFIXES.has(word) && (source[quote] === '"' || source[quote] === "'")) {
        markSplice(k, quote);
        i = quoted(quote, source[quote]);
        continue;
      }
      if (HAS_INCLUDE.has(word) || (moduleImports && word === "import" && first)) {
        let j = skipLayout(k);
        if (HAS_INCLUDE.has(word)) j = source[j] === "(" ? skipLayout(j + 1) : -1;
        if (j >= 0 && source[j] === "<") { i = quoted(j, ">"); continue; }
      }
      if (moduleImports && word === "export" && first) {
        // `export import <header>;` keeps the line's first-token status for import.
        lineHasToken = false;
      }
      i = k;
      continue;
    }
    if (ucn) {
      // A UCN clang reads as an unknown token of its own.
      markSplices(i, ucn.end);
      i = ucn.end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = quoted(i, ch);
      continue;
    }
    i++;
  }
  return out.join("");
}
