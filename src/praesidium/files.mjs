/** @implements RV-PRAESIDIUM-01 — inspect tracked and nonignored new regular sources. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse, resolve, relative, isAbsolute, sep } from "node:path";
import { isPolicySource } from "./languages.mjs";
import { contract } from '../contract-runtime.mjs'; /* augur-inject:import:57936444 */
import augurContract_76cae6ab from '../../contracts/changed-source-paths.contract.mjs'; /* augur-inject:contract-predicate:d1406037 */

// A repository file's path, when its real path lies inside the root's and it is a regular
// file, not a link. `paths` (realPaths), when given, resolves the paths of many calls once
// each, so a collection of files deep in one directory costs their components, not the
// square of the depth for each.
export function containedFile(root, file, paths = undefined) {
  if (typeof file !== "string" || !file || isAbsolute(file)) throw new Error("relative file required");
  const absolute = resolve(root, file);
  const real = path => {
    const found = paths ? realPath(paths, resolve(path))?.path : realpathSync.native(path);
    if (found === undefined) throw new Error("no such file");
    return found;
  };
  const rel = relative(real(root), real(absolute));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error("unsafe file boundary");
  return absolute;
}

// `.m` is also MATLAB, Octave and Mathematica source. Executable C-family code needs a
// body, which opens with `{`, `<%` or `??<`, and a macro that could supply one needs a
// directive (`#`, `%:`, `??=`) or a module import (`@import`, or a pragma operator:
// `_Pragma("clang module import X")`, `__pragma(...)`). A `.m` whose bytes show none of
// them anywhere, not even in a comment, holds no Objective-C to inspect and is left out.
// Any of them keeps it Objective-C (fail closed), and a `.m` configured as a unit always
// is. Only the lowercase `.m` is MATLAB's: clang and GCC compile `.M` as Objective-C++
// (a configured `.M` takes the language of its declared standard instead), where a
// file-scope initializer runs code without any of these marks, so a `.M` is always kept.
const AMBIGUOUS_SOURCE = /\.m$/;
// Splices join lines before tokens form: `<\` + newline + `%` is `<%` (CR LF and LF CR are
// one line break, as for clang).
const LINE_SPLICE = /(?:\\|\?\?\/)[ \t\f\v]*(?:\r\n|\n\r|\r|\n)/g;
const C_FAMILY_DIRECTIVE = /#|<%|%:|\?\?[=<]|\b(?:_Pragma|__pragma)\b/;
const OPEN_BRACE = 0x7b;
const AT_SIGN = 0x40;
const SPLICE_SPACE = new Set([0x20, 0x09, 0x0b, 0x0c]);
// A `.m` is read whole before it is known to be a source, so these bound that read.
const AMBIGUOUS_FILE_LIMIT = 64 * 1024 * 1024;
const AMBIGUOUS_TOTAL_LIMIT = 256 * 1024 * 1024;

function mayHoldObjectiveC(bytes) {
  const text = bytes.toString("latin1").replace(LINE_SPLICE, "");
  if (C_FAMILY_DIRECTIVE.test(text) || hasTokenByte(bytes, OPEN_BRACE)) return true;
  // `@import` may be split by a comment, so `@` and `import` count anywhere.
  return /\bimport\b/.test(text) && hasTokenByte(bytes, AT_SIGN);
}

function hasTokenByte(bytes, byte) {
  for (let at = bytes.indexOf(byte); at !== -1; at = bytes.indexOf(byte, at + 1)) {
    if (mayBeToken(bytes, at)) return true;
  }
  return false;
}

// Non-ASCII bytes that are not well-formed UTF-8 cannot stand outside a comment or a
// literal: clang ("not valid UTF-8") and GCC ("stray") reject them there, and the
// comment or literal that holds them also holds the byte after them, since each ends
// with an ASCII byte. So a `{` or `@` right after such bytes is no token. This keeps
// out the Shift_JIS, GBK and Big5 characters whose second byte is `{` or `@` (`本`,
// `ボ`, the ideographic space). GCC decodes UTF-8 across a line splice, so bytes right
// after one may continue a character and count.
function mayBeToken(bytes, at) {
  let start = at;
  while (start > 0 && bytes[start - 1] >= 0x80) start -= 1;
  return start === at || followsLineSplice(bytes, start) || looseUtf8(bytes, start, at);
}

function followsLineSplice(bytes, end) {
  let at = end;
  if (bytes[at - 1] === 0x0a) at -= bytes[at - 2] === 0x0d ? 2 : 1;
  else if (bytes[at - 1] === 0x0d) at -= 1;
  else return false;
  while (SPLICE_SPACE.has(bytes[at - 1])) at -= 1;
  return bytes[at - 1] === 0x5c || (bytes[at - 1] === 0x2f && bytes[at - 2] === 0x3f && bytes[at - 3] === 0x3f);
}

// Lead and continuation bytes only; overlong and out-of-range forms pass, which counts
// more bytes as UTF-8 and so keeps more files (fail closed).
function looseUtf8(bytes, start, end) {
  for (let at = start; at < end;) {
    const lead = bytes[at];
    const length = lead >= 0xf8 ? 0 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    if (length === 0 || at + length > end) return false;
    for (let next = at + 1; next < at + length; next += 1) if (bytes[next] > 0xbf) return false;
    at += length;
  }
  return true;
}

// The files praesidium.json configures as native units. scan.mjs validates the file
// itself, so an unreadable one configures nothing here and fails there.
function configuredUnitFiles(root) {
  try {
    const file = containedFile(root, "praesidium.json");
    if (lstatSync(file).size > 1024 * 1024) return new Set();
    const units = JSON.parse(readFileSync(file, "utf8"))?.native;
    return new Set((Array.isArray(units) ? units : []).map((unit) => unit?.file).filter((file) => typeof file === "string"));
  } catch { return new Set(); }
}

/**
 * What paths lead to, asked of the system once per scan, so paths that share directories
 * share that work: a node per real path (`of`: its `path`, and its `stats` when a step read
 * them), and what a name in it leads to (`child`: the node, null for nothing; one lstat, and
 * the link's target for a link; a real directory's `..` is the directory it lies in). Every
 * node is kept by its real path, so a directory reached again, by its name, through a `..`
 * or through a link, is the same node and nothing below it is asked again.
 */
export function realPaths() {
  const nodes = new Map();
  const of = path => {
    if (!nodes.has(path)) nodes.set(path, { path, stats: undefined, children: new Map() });
    return nodes.get(path);
  };
  const step = (node, name) => {
    if (name === "" || name === "." || name === "..") return !statSync(node.path).isDirectory() ? null : name === ".." ? of(dirname(node.path)) : node;
    const path = node.path.endsWith(sep) ? node.path + name : node.path + sep + name, stats = lstatSync(path);
    return stats.isSymbolicLink() ? of(realpathSync.native(path)) : Object.assign(of(path), { stats });
  };
  const child = (node, name) => {
    if (!node.children.has(name)) {
      let found = null;
      try { found = step(node, name); } catch { /* it names nothing */ }
      node.children.set(name, found);
    }
    return node.children.get(name);
  };
  return { of, child };
}

/**
 * The node (realPaths) of the real path an absolute path names, or null for none, read one
 * component at a time from its root as the system reads it: each `..` from the directory
 * reached before it, a link as its target (removing `x/..` from the text does not do that
 * through a link). What each component leads to is asked once per `paths`, so a path costs
 * its components, not its length at each one.
 */
export function realPath(paths, named) {
  const top = parse(named).root;
  let node = paths.of(top);
  for (const part of named.slice(top.length).split(sep)) if (!(node = paths.child(node, part))) return null;
  return node;
}

// The listing each collection read, by the sources it returned (repositoryFiles).
const listings = new WeakMap();

/**
 * The repository's own files, tracked or new and not ignored, as Git lists them (at most
 * 4 MiB). The dependency scan reads the listing the collection of `sources` read, so Git
 * is asked for this listing once per run; without one (sources collected otherwise) it is
 * asked again.
 */
export function repositoryFiles(root, sources = undefined) {
  if (listings.has(sources)) return listings.get(sources);
  return [...new Set(gitPaths(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))];
}

export function trackedSources(root) {
  const paths = repositoryFiles(root);
  if (paths.length > 30_000) throw new Error("file count limit");
  let bytes = 0;
  let inspected = 0;
  let configured;
  const resolved = realPaths();
  const sources = paths.filter(isPolicySource).flatMap((file) => {
    const path = containedFile(root, file, resolved);
    const size = lstatSync(path).size;
    let raw;
    if (AMBIGUOUS_SOURCE.test(file)) {
      // Decided before the source limits: a `.m` left out is no source and counts only here.
      inspected += size;
      if (size > AMBIGUOUS_FILE_LIMIT || inspected > AMBIGUOUS_TOTAL_LIMIT) throw new Error("source size limit");
      raw = readFileSync(path);
      if (!mayHoldObjectiveC(raw) && !(configured ??= configuredUnitFiles(root)).has(file)) return [];
    }
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("source size limit");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(raw ?? readFileSync(path));
    if (source.includes("\0")) throw new Error("non-text source");
    return [{ file, source }];
  });
  listings.set(sources, paths);
  return sources;
}

function gitPaths(root, args) {
  const listing = execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return listing.split("\0").filter(Boolean);
}

/**
 * Paths added or modified since `base` plus nonignored new files; deletions are excluded.
 * Paths are relative to `root` like `git ls-files`, also when `root` is a subdirectory.
 */
export function changedSourcePaths(root, base) {
  if (typeof base !== "string" || !base || base.startsWith("-")) throw new Error("base ref required");
  return [...new Set([
    ...gitPaths(root, ["diff", "--relative", "--name-only", "-z", "--no-renames", "--diff-filter=d", base, "--"]),
    ...gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])];
}
// @ts-expect-error augur-inject
changedSourcePaths = contract(changedSourcePaths, { ...augurContract_76cae6ab, contractId: 'C-20', mode: 'observe', sample: 1, where: 'src/praesidium/files.mjs:43', rule: 'contract-wrap', id: '76cae6ab' }); /* augur-inject:contract-wrap:76cae6ab */

// A unit's entry is compared by value, so reordering keys or reformatting the file
// reconfigures nothing.
const entryKey = (unit) => JSON.stringify(unit, Object.keys(unit).sort());

/**
 * Units whose `praesidium.json` entry is new, differs from `base`'s copy, or was removed.
 * Changing how a unit is analyzed (includes, defines, standard, packages, or no longer
 * at all) must be analyzed by the PR that changes it; otherwise the PR passes without
 * compiling the unit and the failure lands on the next, unrelated PR that touches it.
 */
export function reconfiguredNativeUnits(root, base, current) {
  if (typeof base !== "string" || !base || base.startsWith("-")) throw new Error("base ref required");
  let previous = [];
  if (gitPaths(root, ["ls-tree", "-z", "--name-only", base, "--", "praesidium.json"]).length > 0) {
    // `./` names the copy beside `root`, the one ls-tree found, also from a subdirectory.
    const text = execFileSync("git", ["show", `${base}:./praesidium.json`], {
      cwd: root, encoding: "utf8", windowsHide: true, shell: false,
      timeout: 10_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    // An unreadable base configuration configured nothing that still holds.
    try { previous = JSON.parse(text).native; } catch { previous = []; }
  }
  const plain = (unit) => unit !== null && typeof unit === "object" && !Array.isArray(unit) && typeof unit.file === "string";
  const before = new Map((Array.isArray(previous) ? previous : []).filter(plain).map((unit) => [unit.file, entryKey(unit)]));
  const now = (Array.isArray(current) ? current : []).filter(plain);
  const kept = new Set(now.map((unit) => unit.file));
  return [...now.filter((unit) => before.get(unit.file) !== entryKey(unit)).map((unit) => unit.file),
    ...[...before.keys()].filter((file) => !kept.has(file))];
}

/** The paths a review must cover: changed paths plus units the change reconfigured. */
export function reviewedPaths(root, base) {
  const changed = changedSourcePaths(root, base);
  // A missing praesidium.json declares no units (as in scan.mjs), so deleting it drops
  // every unit its base copy declared; the diff above lists no deletions.
  const present = existsSync(join(root, "praesidium.json"));
  if (present && !changed.includes("praesidium.json")) return changed;
  let current = [];
  if (present) {
    const file = containedFile(root, "praesidium.json");
    if (lstatSync(file).size > 1024 * 1024) throw new Error("configuration size limit");
    current = JSON.parse(readFileSync(file, "utf8"))?.native;
  }
  return [...new Set([...changed, ...reconfiguredNativeUnits(root, base, current)])];
}
