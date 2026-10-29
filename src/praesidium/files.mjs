/** @implements RV-PRAESIDIUM-01 — inspect tracked and nonignored new regular sources. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { contract } from '../contract-runtime.mjs'; /* augur-inject:import:57936444 */
import augurContract_76cae6ab from '../../contracts/changed-source-paths.contract.mjs'; /* augur-inject:contract-predicate:d1406037 */

export function containedFile(root, file) {
  if (typeof file !== "string" || !file || isAbsolute(file)) throw new Error("relative file required");
  const absolute = resolve(root, file);
  const rel = relative(realpathSync(root), realpathSync(absolute));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error("unsafe file boundary");
  return absolute;
}

export function trackedSources(root) {
  const listing = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const paths = [...new Set(listing.split("\0").filter(Boolean))];
  if (paths.length > 30_000) throw new Error("file count limit");
  let bytes = 0;
  return paths.filter((file) => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|jsx|mjs|cjs|ts|tsx)$/i.test(file)).map((file) => {
    const path = containedFile(root, file);
    const size = lstatSync(path).size;
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("source size limit");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
    if (source.includes("\0")) throw new Error("non-text source");
    return { file, source };
  });
}

function gitPaths(root, args) {
  const listing = execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return listing.split("\0").filter(Boolean);
}

/** Paths added or modified since `base` plus nonignored new files; deletions are excluded. */
export function changedSourcePaths(root, base) {
  if (typeof base !== "string" || !base || base.startsWith("-")) throw new Error("base ref required");
  return [...new Set([
    ...gitPaths(root, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", base, "--"]),
    ...gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])];
}
// @ts-expect-error augur-inject
changedSourcePaths = contract(changedSourcePaths, { ...augurContract_76cae6ab, contractId: 'C-20', mode: 'observe', sample: 1, where: 'src/praesidium/files.mjs:43', rule: 'contract-wrap', id: '76cae6ab' }); /* augur-inject:contract-wrap:76cae6ab */
