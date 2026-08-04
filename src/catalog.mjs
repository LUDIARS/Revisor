import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { RevisorError } from "./errors.mjs";

const CATALOG_DIR_RELATIVE_PATH = join("Excubitor", "catalog");
const CENTRAL_CATALOG_FILE = "services.yaml";

/**
 * workspace root = `Excubitor/catalog/` を持つ最も近い祖先。
 *
 * 以前は `Excubitor/catalog/services.yaml` の存在を目印にしていたが、
 * 「各サービスが自分の catalog を持つ」方針で中央 services.yaml は撤去された
 * (Excubitor `refactor(catalog): require service-owned definitions`)。
 * ファイルではなくディレクトリを目印にして、中央カタログの有無に依存しない。
 */
export function findWorkspaceRoot(cwd = process.cwd()) {
  let current = resolve(cwd);
  const root = parse(current).root;
  while (true) {
    if (existsSync(join(current, CATALOG_DIR_RELATIVE_PATH))) return current;
    if (current === root) break;
    current = dirname(current);
  }
  throw new RevisorError("Excubitor catalog directory was not found above the current directory.");
}

/** 中央カタログのパス。撤去済みなら null (断片だけで解決する)。 */
export function findExcubitorCatalog(cwd = process.cwd()) {
  const candidate = join(findWorkspaceRoot(cwd), CATALOG_DIR_RELATIVE_PATH, CENTRAL_CATALOG_FILE);
  return existsSync(candidate) ? candidate : null;
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

/**
 * Excubitor の catalog は「公開リポの services.yaml」と「各リポ直下の
 * excubitor.catalog.yaml (断片)」の 2 ソースからなる。private な定義が公開リポへ
 * 流出しないよう断片へ移されたサービスは services.yaml に現れないため、そこだけを
 * 見ると解決できない (実例: Genius は Genius/excubitor.catalog.yaml にしか無く、
 * genius-review が全リポのレビューで落ちていた)。断片は services.yaml と同じ
 * サービスブロック形式なので、同じパーサをそのまま当てられる。
 */
function readServicePortFromFragments(workspaceRoot, serviceCode) {
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fragment = join(workspaceRoot, entry.name, "excubitor.catalog.yaml");
    if (!existsSync(fragment)) continue;
    try {
      return readServicePort(readFileSync(fragment, "utf8"), serviceCode);
    } catch {
      // この断片は当該サービスを宣言していないだけ。次を見る。
    }
  }
  return null;
}

export function resolveServicePort(cwd, serviceCode = "revisor") {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const catalogPath = findExcubitorCatalog(cwd);
  let centralError = null;
  if (catalogPath) {
    try {
      return readServicePort(readFileSync(catalogPath, "utf8"), serviceCode);
    } catch (error) {
      if (!(error instanceof RevisorError)) throw error;
      centralError = error;
    }
  }
  const fromFragment = readServicePortFromFragments(workspaceRoot, serviceCode);
  if (fromFragment !== null) return fromFragment;
  throw centralError
    ?? new RevisorError(`Service '${serviceCode}' is not registered in Excubitor.`);
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
  return findWorkspaceRoot(cwd);
}
