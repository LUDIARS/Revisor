/** @implements RV-PRAESIDIUM-03 — the repository files a compiler pass read, given the policy rules. */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realPath, realPaths } from "./files.mjs";
import { isNativeFragment, isNativeSource } from "./languages.mjs";
import { sourceFindings } from "./rules.mjs";

// The diagnostics pass lists every file it read (`-MD -MF <file> -MT praesidium`, make
// syntax) in a temporary directory outside the checkout.
export const DEPENDENCY_TARGET = "praesidium";
const DEPENDENCY_LIST_LIMIT = 4 * 1024 * 1024;
const DEPENDENCY_FILE_LIMIT = 2 * 1024 * 1024;
const DEPENDENCY_TOTAL_LIMIT = 32 * 1024 * 1024;
const DEPENDENCY_CANDIDATE_LIMIT = 4096;
// Read with the lexical rules of a header (C17, C23 and C++), whatever the file's name.
const DEPENDENCY_LEXING_NAME = "dependency.h";

/**
 * The files a make-syntax dependency list names, read as clang writes it: a space or a
 * line break separates names, `\` before a line break continues the line, `\ ` is a
 * space (the backslashes right before it doubled), `\#` a `#` and `$$` a `$`. Any other
 * character, a tab or a Unicode space included, belongs to the name.
 */
export function dependencyList(text) {
  const tokens = text.replace(/\\\r?\n/g, " ").match(/(?:\\[^\r\n]|[^ \r\n\\])+/g) ?? [];
  if (tokens[0] !== `${DEPENDENCY_TARGET}:`) throw new Error("unexpected dependency list");
  return tokens.slice(1).map(token => token.replace(/\\+[ #]?/g, unescapeRun).replaceAll("$$", "$"));
}

// A run of backslashes, with the space or `#` it escapes. The run is matched whole (no
// backtracking), so a long run stays linear.
function unescapeRun(run) {
  const character = run.at(-1);
  if (character !== " " && character !== "#") return run;
  return "\\".repeat(character === " " ? (run.length - 1) >> 1 : run.length - 2) + character;
}

export function readDependencyList(path) {
  if (statSync(path).size > DEPENDENCY_LIST_LIMIT) throw new Error("dependency list limit");
  return dependencyList(readFileSync(path, "utf8"));
}

/** A path a compiler named, as a repository path (`/`-separated), or null outside the root. */
export function repositoryFile(realRoot, root, path) {
  return withinRoot(realRoot, realpathSync.native(namedPath(root, path)));
}

// A path a compiler named, absolute and not normalized: the system resolves each `..` from
// the directory reached before it (through a link, its target), as it did for the compiler,
// which removing `x/..` from the text does not.
const namedPath = (root, path) => isAbsolute(path) ? path : `${resolve(root)}${sep}${path}`;

// A real path as a repository path (`/`-separated), or null outside the root.
function withinRoot(realRoot, real) {
  const rel = relative(realRoot, real);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return sep === "/" ? rel : rel.replaceAll(sep, "/");
}

/**
 * Native policy findings in the repository's own files that an analyzed unit's compiler
 * read but the native policy scan never saw: files that Git tracks or would add (`listing`,
 * from repositoryFiles) outside the extension table (a `.txt`, an extensionless or any
 * other included file, a fragment) and script sources (which the policy scan reads with the
 * script rules only), resolved by the compiler, so a macro-named `#include` cannot hide one.
 * A file Git ignores is not read, and neither are submodule content, host packages and the
 * toolchain, which are not the repository's own, as in the policy scan. A listed name is
 * resolved as the system resolved it for the compiler (realPath). Same limits as
 * collection; an unreadable or oversized file, or a listed name that names no file or a
 * directory (a list read wrongly), fails closed. So does a repository path that holds a
 * backslash: clang lists such a name with a slash there (`src/a\b.txt` as `src/a/b.txt`),
 * so a listed name could stand for another file (a decoy `src/a/b.txt` beside it) or for none.
 * `flagged` holds each dependency path (as listed) whose file has findings.
 */
export function dependencyFindings(root, lists, listing) {
  if (listing.some(file => file.includes("\\"))) throw new Error("backslash in a repository path");
  const realRoot = realpathSync(root);
  const candidates = new Map(), paths = realPaths();
  for (const path of new Set(lists.flat())) {
    const real = realPath(paths, namedPath(root, path));
    if (real === null) throw new Error("dependency names no file");
    const file = withinRoot(realRoot, real.path);
    if (file === null || (isNativeSource(file) && !isNativeFragment(file))) continue;
    real.stats ??= statSync(real.path);
    if (!real.stats.isFile()) throw new Error("dependency is not a file");
    if (!candidates.has(file)) candidates.set(file, { real, listed: [] });
    candidates.get(file).listed.push(path);
  }
  const flagged = new Set(), items = [];
  if (candidates.size > DEPENDENCY_CANDIDATE_LIMIT) throw new Error("dependency count limit");
  // Only the repository's own files are read, and every size is checked before any is.
  const own = new Set(listing), files = [...candidates].filter(([file]) => own.has(file));
  let bytes = 0;
  for (const [, { real }] of files) {
    const size = real.stats.size;
    bytes += size;
    if (size > DEPENDENCY_FILE_LIMIT || bytes > DEPENDENCY_TOTAL_LIMIT) throw new Error("source size limit");
  }
  for (const [file, { real, listed }] of files) {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real.path));
    if (source.includes("\0")) throw new Error("non-text source");
    const found = sourceFindings(DEPENDENCY_LEXING_NAME, source).map(item => ({ ...item, file }));
    if (!found.length) continue;
    items.push(...found);
    for (const path of listed) flagged.add(path);
  }
  return { flagged, items };
}
