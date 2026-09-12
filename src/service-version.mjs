/**
 * 「いまそのサービスは何版か」 を 1 つの答えにまとめる。
 *
 * 版は 1 か所にはない。 走っているプロセスが名乗る版 (health の `version`、 AIFormat
 * `RULE_SRE.md` §2) と、 ディスクに置かれている版 (`package.json`)、 そして Revisor が
 * 所有するリリース版 (`.revisor-version`) は別物で、 食い違っていること自体が
 * 「ビルドしたが再起動していない」 「マージしたが公開していない」 の証拠になる。
 * どれか 1 つに丸めると、 まさに知りたかったズレが消える。
 *
 * だから 3 つとも返し、 表示用の代表値 (`version`) だけを「走っている版 → リリース版
 * → ディスク版」 の順で決める。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findServiceDefinitions, listServiceDefinitions } from "./catalog-services.mjs";
import { inspectLocalVersionState } from "./local-version.mjs";
import { RevisorError } from "./errors.mjs";

/** health は「動いているか」を見るためのもの。 版を読むためだけに長く待たない。 */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/** 異常な値を表示側へ流さないための上限 (Excubitor の health-body と同じ方針)。 */
const MAX_VERSION_LENGTH = 64;

/**
 * 制御文字はログ・JSON・Discord 表示のどれも壊す。 サービスが名乗る版は外から来た
 * 文字列なので、 受け取った時点で弾く。
 */
function hasUnsafeCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
}

function sanitizeVersion(value) {
  if (typeof value !== "string") return null;
  const version = value.trim();
  if (!version || version.length > MAX_VERSION_LENGTH || hasUnsafeCharacter(version)) return null;
  return version;
}

/**
 * 引数なしは無効。 「全サービスを黙って舐める」 既定を持たせると、 93 サービス分の
 * health を叩く呼び出しが打ち間違いから生まれる。 何を聞きたいかは呼び出し側が言う。
 *
 * @param {unknown} values
 * @returns {string[]}
 */
export function parseServiceSelectors(values) {
  const selectors = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (selectors.length === 0) {
    throw new RevisorError("At least one service must be named.");
  }
  return [...new Set(selectors)];
}

/** 走っているプロセスが名乗る版。 届かなければ理由を残す (版は null)。 */
async function probeRunningVersion(definition, { fetchImpl, timeoutMs }) {
  if (!definition.healthUrl) {
    return {
      reachable: false,
      version: null,
      error: "No health endpoint is declared in the catalog.",
    };
  }
  try {
    const response = await fetchImpl(definition.healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { reachable: false, version: null, error: `Health responded ${response.status}.` };
    }
    const body = await response.json();
    return { reachable: true, version: sanitizeVersion(body?.version), error: null };
  } catch (error) {
    return {
      reachable: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** catalog の `cwd` に置かれた package.json の版 (= ディスクにあるもの)。 */
async function readPackageVersion(definition) {
  if (!definition.cwd) return null;
  try {
    const manifest = JSON.parse(await readFile(join(definition.cwd, "package.json"), "utf8"));
    return sanitizeVersion(manifest?.version);
  } catch {
    return null; // package.json を持たないサービス (Unity / Rust 等) は版を名乗らないだけ。
  }
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Revisor が所有するリリース版。 catalog の `cwd` はサービスの作業ディレクトリで、
 * 登録 checkout の root とは限らない (Memoria は `<repo>/server`) ので、 前方一致で
 * 一番長く一致した登録リポジトリを採る。
 */
async function readReleaseVersion(definition, repositories) {
  const cwd = normalizePath(definition.cwd);
  if (!cwd) return { repository: null, version: null, status: null };
  const match = (repositories ?? [])
    .filter((repository) => {
      const root = normalizePath(repository.rootPath);
      return root !== "" && (cwd === root || cwd.startsWith(`${root}/`));
    })
    .sort((left, right) =>
      normalizePath(right.rootPath).length - normalizePath(left.rootPath).length)[0];
  if (!match) return { repository: null, version: null, status: null };
  const state = await inspectLocalVersionState(match.rootPath);
  return {
    repository: match.repository,
    version: state.status === "ready" ? state.version : null,
    status: state.status,
  };
}

async function describeService(definition, { repositories, fetchImpl, timeoutMs }) {
  const [running, packageVersion, release] = await Promise.all([
    probeRunningVersion(definition, { fetchImpl, timeoutMs }),
    readPackageVersion(definition),
    readReleaseVersion(definition, repositories),
  ]);
  return {
    service: definition.code,
    name: definition.name,
    repository: release.repository,
    cwd: definition.cwd,
    port: definition.port,
    version: running.version ?? release.version ?? packageVersion,
    running,
    packageVersion,
    releaseVersion: release.version,
    releaseStatus: release.status,
  };
}

/**
 * @param {string[]} selectors 1 件以上のサービス名 (Excubitor code / リポジトリ / プロジェクトコード)。
 * @returns {Promise<{ requested: string, found: boolean, services: object[] }[]>}
 *   要求 1 件につき 1 要素。 解決できなかった要求も `found: false` で残す — 黙って
 *   落とすと「聞いたサービスが答えに無い」ことに呼び出し側が気付けない。
 */
export async function collectServiceVersions(selectors, {
  cwd = process.cwd(),
  repositories = [],
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const definitions = listServiceDefinitions(cwd);
  return Promise.all(parseServiceSelectors(selectors).map(async (requested) => {
    const matches = findServiceDefinitions(definitions, requested);
    return {
      requested,
      found: matches.length > 0,
      services: await Promise.all(matches.map((definition) =>
        describeService(definition, { repositories, fetchImpl, timeoutMs }))),
    };
  }));
}

/** CLI / 通知向けの 1 行表示。 */
export function formatServiceVersionLine(service) {
  const running = service.running.reachable
    ? `running ${service.running.version ?? "(unreported)"}`
    : "not running";
  return `${service.service}: ${service.version ?? "unknown"} (${running}`
    + `, package ${service.packageVersion ?? "-"}`
    + `, release ${service.releaseVersion ?? "-"})`;
}
