/** Host-owned compiler/header locations; never read these paths from a reviewed repository. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { resolveConfigPath } from "../config.mjs";

const packageName = /^[a-z][a-z0-9-]{0,63}$/;
const record = value => value && typeof value === "object" && !Array.isArray(value);

function absoluteLocation(value, directory) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0-\x1f\x7f]/.test(value)) throw new Error("invalid host location");
  const resolved = realpathSync(value);
  const stat = statSync(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("invalid host location type");
  return resolved;
}

export function readNativeHost(root, env = process.env) {
  const path = join(dirname(resolveConfigPath(env)), "praesidium.host.json");
  if (!existsSync(path)) return { compilers: {}, includePackages: {} };
  // A PR must not become its own authority for external compiler/include paths.
  const rel = relative(realpathSync(root), realpathSync(path));
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\")) throw new Error("host configuration is inside reviewed repository");
  if (statSync(path).size > 65536) throw new Error("host configuration size limit");
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!record(config) || config.version !== 1 || Object.keys(config).some(key => !["version", "compilers", "includePackages"].includes(key))) throw new Error("invalid native host configuration");
  const compilers = {}, includePackages = {};
  if (!record(config.compilers ?? {}) || !record(config.includePackages ?? {})) throw new Error("invalid native host locations");
  for (const [name, value] of Object.entries(config.compilers ?? {})) {
    if (!["c", "cpp"].includes(name)) throw new Error("unknown compiler kind");
    compilers[name] = absoluteLocation(value, false);
  }
  const packages = Object.entries(config.includePackages ?? {});
  if (packages.length > 64) throw new Error("header package limit");
  for (const [name, value] of packages) {
    if (!packageName.test(name)) throw new Error("invalid header package name");
    includePackages[name] = absoluteLocation(value, true);
  }
  return { compilers, includePackages };
}

export function nativePackageIncludes(names, host) {
  if (!Array.isArray(names) || names.length > 32 || new Set(names).size !== names.length) throw new Error("invalid header packages");
  return names.map(name => {
    if (typeof name !== "string" || !packageName.test(name)
      || !Object.hasOwn(host.includePackages ?? {}, name)) throw new Error("header package not installed on inspection host");
    return host.includePackages[name];
  });
}
