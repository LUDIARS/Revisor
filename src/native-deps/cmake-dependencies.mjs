/**
 * @implements RV-NATIVE-DEPS-01 — C++ libraries a CMake build fetches.
 *
 * `FetchContent_Declare(name GIT_REPOSITORY url GIT_TAG ref ...)` and
 * `ExternalProject_Add(name ...)` name a library and the revision the build
 * pins. `${VAR}` references are resolved from plain `set(VAR value)` in the
 * same file; anything else stays unresolved and is reported, never guessed.
 *
 * SRP: extracting declared dependencies from CMake text.
 */

const COMMANDS = /\b(FetchContent_Declare|ExternalProject_Add)\s*\(/gi;
const SET = /\bset\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+("([^"]*)"|([^\s)]+))/gi;
const KEYWORDS = new Set(["GIT_REPOSITORY", "GIT_TAG", "URL", "URL_HASH", "SOURCE_DIR", "GIT_SHALLOW", "GIT_PROGRESS"]);

function stripComments(text) {
  return text.replace(/#\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/#[^\n]*/g, "");
}

/** Arguments of the command whose `(` sits at `open`, quoted strings kept whole. */
function argumentsAt(text, open) {
  const args = [];
  let depth = 1;
  let index = open + 1;
  let token = "";
  const flush = () => {
    if (token !== "") args.push(token);
    token = "";
  };
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "\"") {
      const end = text.indexOf("\"", index + 1);
      token += text.slice(index + 1, end < 0 ? text.length : end);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
    if (/\s/.test(ch)) flush();
    else token += ch;
    index += 1;
  }
  flush();
  return args;
}

function variables(text) {
  const values = new Map();
  for (const match of text.matchAll(SET)) values.set(match[1], match[3] ?? match[4]);
  return values;
}

function expand(value, values) {
  if (value === undefined) return undefined;
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => values.get(name) ?? whole);
  return expanded.includes("${") ? undefined : expanded;
}

function keyed(args) {
  const fields = {};
  for (let index = 1; index < args.length; index += 1) {
    if (KEYWORDS.has(args[index]) && index + 1 < args.length) fields[args[index]] = args[index + 1];
  }
  return fields;
}

/**
 * `[{ kind: "cmake", name, file, repository?, revision?, url?, unresolved? }]`
 * for one CMake file's text.
 * @implements RV-NATIVE-DEPS-01
 */
export function cmakeDependencies(file, text) {
  const clean = stripComments(text);
  const values = variables(clean);
  const found = [];
  for (const match of clean.matchAll(COMMANDS)) {
    const args = argumentsAt(clean, match.index + match[0].length - 1);
    if (args.length === 0 || args[0].includes("${") && expand(args[0], values) === undefined) continue;
    const fields = keyed(args);
    const name = expand(args[0], values) ?? args[0];
    const repository = expand(fields.GIT_REPOSITORY, values);
    const revision = expand(fields.GIT_TAG, values);
    const url = expand(fields.URL, values);
    const dependency = { kind: "cmake", name, file };
    if (repository !== undefined) dependency.repository = repository;
    if (revision !== undefined) dependency.revision = revision;
    if (url !== undefined) dependency.url = url;
    if ((fields.GIT_REPOSITORY !== undefined && repository === undefined)
        || (fields.GIT_TAG !== undefined && revision === undefined)
        || (fields.URL !== undefined && url === undefined)) {
      dependency.unresolved = "a ${VAR} in the declaration is not set in the same file";
    } else if (repository === undefined && url === undefined) {
      dependency.unresolved = "no GIT_REPOSITORY or URL";
    } else if (repository !== undefined && revision === undefined) {
      dependency.unresolved = "GIT_REPOSITORY without a pinned GIT_TAG";
    }
    found.push(dependency);
  }
  return found;
}
