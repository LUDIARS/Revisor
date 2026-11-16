/** @implements RV-PRAESIDIUM-03 — analyzer reports that end and mostly run inside host packages are recorded, not blocking. */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// One diagnostic line of `-analyzer-output=text`: `<path>:<line>:<column>: <kind>: <text>`.
// The path is matched lazily, so a Windows drive (`C:\x.hpp:3:1:`) stays part of it. The
// checker that raised a warning closes its text (`[core.NullDereference]`).
const DIAGNOSTIC = /^(.+?):(\d+):(\d+): (warning|note|error|fatal error): (.*?)\r?$/;
const CHECKER = /\[([A-Za-z0-9_.-]+)\]$/;
// What a line with a diagnostic word but no location means: a driver or toolchain
// problem, which can hold no host report.
const UNLOCATED = /\b(?:warning|error):/;

/** The `-isystem` directories of a compiler invocation: the host packages (native-host.mjs). */
export function hostDirectories(args) {
  return args.flatMap((arg, index) => arg === "-isystem" && typeof args[index + 1] === "string" ? [args[index + 1]] : []);
}

/**
 * The analyzer reports in text output: each warning with the path notes that follow it
 * until the next warning. `errors` is true when any line reports an error, or a
 * diagnostic word stands on a line that names no location (which no report explains).
 */
export function analyzerReports(text) {
  const reports = [];
  let errors = false;
  for (const line of text.split("\n")) {
    const match = DIAGNOSTIC.exec(line);
    if (!match) {
      if (UNLOCATED.test(line)) errors = true;
      continue;
    }
    const [, path, row, , kind, message] = match;
    const location = { path, line: Number(row) };
    if (kind === "warning") reports.push({ ...location, checker: CHECKER.exec(message)?.[1] ?? null, notes: [] });
    else if (kind === "note") reports.at(-1)?.notes.push(location);
    else errors = true;
  }
  return { reports, errors };
}

const folded = path => process.platform === "win32" ? path.toLowerCase() : path;

function realLocation(cwd, path) {
  const named = resolve(cwd, path);
  try { return realpathSync.native(named); } catch { return named; }
}

// The path below `directory`, `/`-separated, or null when it is not inside it.
function inside(directory, path) {
  const rel = relative(folded(directory), folded(path));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return relative(directory, path).replaceAll(sep, "/");
}

/**
 * Where a report location lies: "repository" inside the analyzed root (also when a host
 * directory lies inside it), "host" inside a host package, else "other" (the toolchain,
 * the baseline). A location is resolved like the compiler resolved it, so a `..` cannot
 * climb out of a host directory and still read as inside it.
 */
function placeOf(cwd, hosts, path) {
  const real = realLocation(cwd, path);
  if (inside(realLocation(cwd, "."), real) !== null) return { place: "repository" };
  for (const host of hosts) {
    const file = inside(realLocation(cwd, host), real);
    if (file !== null) return { place: "host", file };
  }
  return { place: "other" };
}

/**
 * Split the analyzer pass's output into reports that end in a host package and whose path
 * runs there at least as often as through repository code (advisory), and the rest
 * (`blocking`, a count). A report that ends in repository code, or reaches the host
 * library mostly from repository code (a null passed down to a library dereference), keeps
 * failing the unit. Null when the output cannot be read as reports alone: an error, a
 * diagnostic without location, or no warning at all although the pass reported one.
 * Advisories hold only the package-relative file, its line and the checker: no source text.
 */
export function hostAnalyzerReports(text, cwd, hosts) {
  const { reports, errors } = analyzerReports(text);
  if (errors || reports.length === 0) return null;
  const advisories = [];
  let blocking = 0;
  for (const report of reports) {
    const end = placeOf(cwd, hosts, report.path);
    let host = 0, repository = 0;
    for (const note of report.notes) {
      const { place } = placeOf(cwd, hosts, note.path);
      if (place === "host") host++;
      else if (place === "repository") repository++;
    }
    if (end.place === "host" && host >= repository) {
      advisories.push({ file: end.file, line: report.line, checker: report.checker });
    } else blocking++;
  }
  return { advisories, blocking };
}
