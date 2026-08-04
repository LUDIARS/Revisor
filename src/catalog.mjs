import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { RevisorError } from "./errors.mjs";

const CATALOG_RELATIVE_PATH = join("Excubitor", "catalog", "services.yaml");

export function findExcubitorCatalog(cwd = process.cwd()) {
  let current = resolve(cwd);
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, CATALOG_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    if (current === root) break;
    current = dirname(current);
  }
  throw new RevisorError("Excubitor catalog was not found above the current directory.");
}

export function readServicePort(catalogText, serviceCode) {
  const blocks = catalogText.split(/(?=^  - code:)/m);
  const block = blocks.find((candidate) =>
    candidate.match(/^  - code:\s*(\S+)\s*$/m)?.[1] === serviceCode);
  if (!block) {
    throw new RevisorError(`Service '${serviceCode}' is not registered in Excubitor.`);
  }
  const port = Number(block.match(/^    port:\s*(\d+)\s*$/m)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RevisorError(`Service '${serviceCode}' has no valid catalog port.`);
  }
  return port;
}

export function resolveServicePort(cwd, serviceCode = "revisor") {
  return readServicePort(
    readFileSync(findExcubitorCatalog(cwd), "utf8"),
    serviceCode,
  );
}

export function readInjectedServicePort(env, serviceCode) {
  const key = `${serviceCode.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
  const raw = env?.[key];
  if (raw === undefined) return null;
  // The regex already pins `raw` to a decimal integer of at least 1, so the
  // upper bound is the only range check left.
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || Number(raw) > 65535) {
    throw new RevisorError(`Excubitor injected an invalid ${key}.`);
  }
  return Number(raw);
}

// Excubitor derives <CODE>_PORT from its aggregated catalog (including
// per-repository fragments) and injects it into managed child processes. Use
// that value for the service's own listener to avoid a bootstrap dependency on
// the public base catalog. Direct CLI launches retain the central-catalog path.
export function resolveManagedServicePort(cwd, env, serviceCode = "revisor") {
  return readInjectedServicePort(env, serviceCode)
    ?? resolveServicePort(cwd, serviceCode);
}

export function resolveServiceLoopbackUrl(cwd, serviceCode) {
  return `http://127.0.0.1:${resolveServicePort(cwd, serviceCode)}`;
}

export function resolveWorkspaceRoot(cwd) {
  return dirname(dirname(dirname(findExcubitorCatalog(cwd))));
}
