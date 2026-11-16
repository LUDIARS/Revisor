/** @implements RV-PRAESIDIUM-03 — repository files that could relocate an analyzer report into a host package. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { maskNativeCode } from "./native-lexer.mjs";

const FILE_LIMIT = 2 * 1024 * 1024;
// `#line 12 "file"` (also `# line`, `%:line`, a comment between) in the masked logical
// view, where comments are blank and a digraph reads as `#`. A GNU linemarker (`# 12`)
// is already rejected by the policy rules.
const LINE_DIRECTIVE = /^[ \t]*#[ \t]*line\b/m;
// Read as C++ and as C: a raw string exists only in C++, so either reading could hide a
// directive the other shows.
const READINGS = [{}, { rawStrings: false, digitSeparators: false, moduleImports: false }];

function holdsLineDirective(path) {
  if (statSync(path).size > FILE_LIMIT) return true;
  const source = readFileSync(path, "utf8");
  return READINGS.some(lexing => LINE_DIRECTIVE.test(maskNativeCode(source, { ...lexing, logical: true })));
}

/**
 * The repository files among those a pass read (`listed`, as the compiler named them) that
 * hold a `#line` directive: one can give any later report another file name, a host
 * package header's included, so a report there no longer shows where it ends. A file that
 * cannot be read counts as holding one (fail closed). `cache` maps real paths to answers.
 */
export function lineDirectiveFiles(root, listed, cache = new Map()) {
  const realRoot = realpathSync(root);
  const found = [];
  for (const path of listed) {
    let real;
    try { real = realpathSync.native(isAbsolute(path) ? path : `${resolve(root)}${sep}${path}`); } catch { found.push(path); continue; }
    const rel = relative(realRoot, real);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    if (!cache.has(real)) {
      let holds;
      try { holds = holdsLineDirective(real); } catch { holds = true; }
      cache.set(real, holds);
    }
    if (cache.get(real)) found.push(path);
  }
  return found;
}
