/**
 * @implements RV-NATIVE-DEPS-01 — submodules, Conan requirements and vendored
 * copies as dependency records.
 *
 * - Submodules: `.gitmodules` names path and URL; the gitlink commit is the pinned revision.
 * - Conan: `conanfile.txt [requires]`, `conanfile.py` requires strings and `conan.lock`.
 * - Vendored copies (code copied under third_party/ etc.) carry no machine-readable
 *   origin, so the repository declares them in `revisor.native-deps.json`:
 *     {"version":1,"vendored":[{"path":"third_party/stb","repository":"https://github.com/nothings/stb","revision":"<commit or tag>"}]}
 *   A vendored directory without a declaration is reported, never guessed.
 *
 * SRP: turning these sources into dependency records.
 */

export const DECLARATION_FILE = "revisor.native-deps.json";
export const VENDOR_ROOTS = ["third_party", "thirdparty", "3rdparty", "external", "extern", "vendor", "deps"];
const NATIVE_FILE = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;

/**
 * `[{ path, url }]` from `.gitmodules` text.
 * @implements RV-NATIVE-DEPS-01
 */
export function parseGitmodules(text) {
  const modules = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const header = /^\s*\[submodule\s+"([^"]+)"\]\s*$/.exec(line);
    if (header) {
      current = { name: header[1] };
      modules.push(current);
      continue;
    }
    const pair = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
    if (pair && current) current[pair[1]] = pair[2];
  }
  return modules.filter((module) => module.path && module.url).map(({ path, url }) => ({ path, url }));
}

/**
 * Submodule records with their pinned commit (`gitlinks`: path -> commit).
 * @implements RV-NATIVE-DEPS-01
 */
export function submoduleDependencies(gitmodulesText, gitlinks) {
  return parseGitmodules(gitmodulesText).map(({ path, url }) => {
    const commit = gitlinks.get(path);
    const dependency = { kind: "submodule", name: path, file: ".gitmodules", repository: url };
    if (commit) dependency.revision = commit;
    else dependency.unresolved = "no gitlink commit recorded for the submodule path";
    return dependency;
  });
}

const REFERENCE = /^([A-Za-z0-9_.+-]+)\/([A-Za-z0-9_.+-]+)(?:@[^#\s]*)?(?:#\S*)?$/;

function conanRecord(reference, file) {
  const match = REFERENCE.exec(reference.trim());
  return match ? { kind: "conan", name: match[1], version: match[2], file } : null;
}

/**
 * Conan requirements from conanfile.txt, conanfile.py or conan.lock text.
 * @implements RV-NATIVE-DEPS-01
 */
export function conanDependencies(file, text) {
  const found = [];
  if (/conan\.lock$/i.test(file)) {
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      return [{ kind: "conan", name: file, file, unresolved: "conan.lock is not valid JSON" }];
    }
    for (const reference of Array.isArray(lock?.requires) ? lock.requires : []) {
      const record = typeof reference === "string" ? conanRecord(reference, file) : null;
      if (record) found.push(record);
    }
    return found;
  }
  if (/conanfile\.txt$/i.test(file)) {
    let inRequires = false;
    for (const line of String(text).split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (section) {
        inRequires = section[1].trim() === "requires";
        continue;
      }
      if (!inRequires || line.trim() === "" || line.trim().startsWith("#")) continue;
      const record = conanRecord(line, file);
      if (record) found.push(record);
    }
    return found;
  }
  for (const match of String(text).matchAll(/["']([A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+(?:@[^"'#\s]*)?(?:#[^"'\s]*)?)["']/g)) {
    const record = conanRecord(match[1], file);
    if (record) found.push(record);
  }
  return found;
}

function invalid(message) {
  return [{ kind: "vendored", name: DECLARATION_FILE, file: DECLARATION_FILE, unresolved: message }];
}

/**
 * Vendored records from `revisor.native-deps.json`; malformed input is one unresolved record.
 * @implements RV-NATIVE-DEPS-01
 */
export function vendoredDependencies(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid(`${DECLARATION_FILE} is not valid JSON`);
  }
  if (json?.version !== 1 || !Array.isArray(json.vendored)) return invalid(`${DECLARATION_FILE} needs {"version":1,"vendored":[...]}`);
  return json.vendored.map((entry, index) => {
    const path = typeof entry?.path === "string" ? entry.path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
    if (!path || typeof entry.repository !== "string" || typeof entry.revision !== "string" || !entry.revision.trim()) {
      return { kind: "vendored", name: path || `vendored[${index}]`, file: DECLARATION_FILE, unresolved: "each entry needs path, repository and revision" };
    }
    return { kind: "vendored", name: path, file: DECLARATION_FILE, repository: entry.repository, revision: entry.revision.trim() };
  });
}

/**
 * Top-level entries under the vendor roots that neither a submodule nor a
 * declaration covers: `third_party/stb` or `third_party/stb_image.h`.
 * @implements RV-NATIVE-DEPS-01
 */
export function undeclaredVendored(files, covered) {
  const roots = new Set(VENDOR_ROOTS);
  const entries = new Set();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length < 2 || !roots.has(parts[0].toLowerCase())) continue;
    // Only C/C++ code is a C++ library: build glue, archives of other ecosystems
    // (an npm .tgz under vendor/) and docs beside it are not.
    if (!NATIVE_FILE.test(file)) continue;
    entries.add(`${parts[0]}/${parts[1]}`);
  }
  return [...entries]
    .filter((entry) => ![...covered].some((path) => entry === path || entry.startsWith(`${path}/`) || path.startsWith(`${entry}/`)))
    .sort()
    .map((entry) => ({ kind: "vendored", name: entry, file: entry, unresolved: `declare its upstream repository and revision in ${DECLARATION_FILE}` }));
}
