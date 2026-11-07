/**
 * @implements RV-NATIVE-DEPS-01 — the C++ dependency inventory of one tree.
 *
 * Only a repository with C/C++ sources has one: a JavaScript project's git
 * submodules are not C++ libraries. Each record gets a stable `key` (what the
 * dependency is) and an `identity` (which revision), so a PR's added or
 * re-pinned dependencies are those whose identity is new.
 *
 * SRP: assembling the dependency records of one tree.
 */
import { cmakeDependencies } from "./cmake-dependencies.mjs";
import {
  conanDependencies,
  DECLARATION_FILE,
  submoduleDependencies,
  undeclaredVendored,
  vendoredDependencies,
} from "./declared-dependencies.mjs";

const NATIVE_SOURCE = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;
const CMAKE_FILE = /(?:^|\/)(?:CMakeLists\.txt|[^/]+\.cmake)$/i;
const CONAN_FILE = /(?:^|\/)(?:conanfile\.txt|conanfile\.py|conan\.lock)$/i;

/**
 * `cmake:glfw`, `submodule:third_party/gtest` — one per dependency.
 * @implements RV-NATIVE-DEPS-01
 */
export function dependencyKey(dependency) {
  return `${dependency.kind}:${dependency.name}`;
}

/**
 * What the record pins; two records with the same key and identity are the same dependency.
 * @implements RV-NATIVE-DEPS-01
 */
export function dependencyIdentity(dependency) {
  return [dependency.repository ?? dependency.url ?? "", dependency.revision ?? dependency.version ?? "", dependency.unresolved ?? ""].join("|");
}

/**
 * `null` when the tree has no C/C++ source (the check does not apply).
 * @implements RV-NATIVE-DEPS-01
 */
export async function nativeInventory(source) {
  const files = await source.files();
  if (!files.some((file) => NATIVE_SOURCE.test(file))) return null;
  const records = [];
  for (const file of files.filter((path) => CMAKE_FILE.test(path)).sort()) {
    records.push(...cmakeDependencies(file, await source.read(file)));
  }
  for (const file of files.filter((path) => CONAN_FILE.test(path)).sort()) {
    records.push(...conanDependencies(file, await source.read(file)));
  }
  const submodules = files.includes(".gitmodules")
    ? submoduleDependencies(await source.read(".gitmodules"), await source.gitlinks())
    : [];
  records.push(...submodules);
  const vendored = files.includes(DECLARATION_FILE) ? vendoredDependencies(await source.read(DECLARATION_FILE)) : [];
  records.push(...vendored);
  const covered = new Set([...submodules, ...vendored].map((dependency) => dependency.name));
  records.push(...undeclaredVendored(files, covered));
  // The same library fetched from two CMake files is one dependency per declaration site.
  const seen = new Set();
  return records.filter((dependency) => {
    const id = `${dependencyKey(dependency)}@${dependency.file}|${dependencyIdentity(dependency)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Records of `head` whose key is new or whose identity changed since `base`.
 * @implements RV-NATIVE-DEPS-01
 */
export function changedDependencies(head, base) {
  if (base === null) return head;
  const before = new Map();
  for (const dependency of base) {
    const key = dependencyKey(dependency);
    before.set(key, [...(before.get(key) ?? []), dependencyIdentity(dependency)]);
  }
  return head.filter((dependency) => !(before.get(dependencyKey(dependency)) ?? []).includes(dependencyIdentity(dependency)));
}
