/**
 * 「いまそのサービスは何版か」 を 1 つの答えにまとめる。
 *
 * 版は 1 か所にはない。 Revisor が所有する版ファイル (`.revisor-version`)、 最後に公開した
 * リリースタグ、 走っているプロセスが名乗る版 (health の `version`、 AIFormat
 * `RULE_SRE.md` §2)、 ディスクに置かれている版 (`package.json`) は別物で、 食い違って
 * いること自体が 「ビルドしたが再起動していない」 「マージしたが公開していない」 の
 * 証拠になる。 どれか 1 つに丸めると、 まさに知りたかったズレが消える。
 *
 * だから 4 つとも返し、 表示用の代表値 (`version`) だけを「版ファイル → リリースタグ →
 * 走行版 → ディスク版」 の順で決める。
 *
 * @implements spec/feature/service-version.md
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
 * @implements SPEC-SERVICE-VERSION-EXPLICIT-TARGET
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

const EMPTY_RELEASE = {
  repository: null,
  version: null,
  status: null,
  latestReleaseTag: null,
  unreleasedCommits: null,
};

/**
 * catalog の `cwd` はサービスの作業ディレクトリで、 登録 checkout の root とは限らない
 * (Memoria は `<repo>/server`) ので、 前方一致で一番長く一致した登録リポジトリを採る。
 */
function matchRepository(definition, repositories) {
  const cwd = normalizePath(definition.cwd);
  if (!cwd) return null;
  return (repositories ?? [])
    .filter((repository) => {
      const root = normalizePath(repository.rootPath);
      return root !== "" && (cwd === root || cwd.startsWith(`${root}/`));
    })
    .sort((left, right) =>
      normalizePath(right.rootPath).length - normalizePath(left.rootPath).length)[0] ?? null;
}

/**
 * 公開済みの版は **Revisor の release state** から取る。
 *
 * `.revisor-version` だけを見ていると、 版管理を初期化していないリポジトリで答えを
 * 見失う。 Concordia は実際に v2.4.0 を公開済みなのに `.revisor-version` は
 * `uninitialized` で、 `package.json` も 0.1.0 のまま — 3 つとも 0.1.0 と答えてしまい、
 * 公開されている 2.4.0 がどこにも出なかった。 release state は最新リリースタグと
 * 未公開コミット数を持つので、 そこを正本にする。
 */
async function readRelease(definition, repositories, releaseState) {
  const match = matchRepository(definition, repositories);
  if (!match) return EMPTY_RELEASE;
  const base = { ...EMPTY_RELEASE, repository: match.repository };
  if (releaseState) {
    try {
      const state = await releaseState(match.repository);
      if (state) {
        return {
          ...base,
          version: state.version?.status === "ready" ? state.version.version : null,
          status: state.version?.status ?? null,
          latestReleaseTag: state.latestReleaseTag ?? null,
          unreleasedCommits: Number.isInteger(state.unreleasedCommitCount)
            ? state.unreleasedCommitCount
            : null,
        };
      }
    } catch {
      // release state は履歴を辿るので、 checkout の状態しだいで失敗する。 版ファイル
      // だけでも答えられるので、 1 リポジトリの失敗で全体を落とさない。
    }
  }
  const file = await inspectLocalVersionState(match.rootPath);
  return {
    ...base,
    version: file.status === "ready" ? file.version : null,
    status: file.status,
  };
}

function withoutTagPrefix(tag) {
  return typeof tag === "string" ? tag.replace(/^v/, "") : null;
}

/**
 * 食い違いを名前で残す。 表示側が「どれとどれが違うか」を組み立て直さずに済ませる
 * ためで、 数値そのものは各欄に残したままにする。
 *
 * @implements SPEC-SERVICE-VERSION-SOURCES
 */
function driftKinds({ released, runningVersion, packageVersion, unreleasedCommits }) {
  const kinds = [];
  if (released && runningVersion && runningVersion !== released) kinds.push("running_differs_from_release");
  if (released && packageVersion && packageVersion !== released) kinds.push("package_differs_from_release");
  if (runningVersion && packageVersion && runningVersion !== packageVersion) kinds.push("running_differs_from_package");
  if (Number.isInteger(unreleasedCommits) && unreleasedCommits > 0) kinds.push("unreleased_commits");
  return kinds;
}

/** @implements SPEC-SERVICE-VERSION-REPRESENTATIVE */
async function describeService(definition, { repositories, releaseState, fetchImpl, timeoutMs }) {
  const [running, packageVersion, release] = await Promise.all([
    probeRunningVersion(definition, { fetchImpl, timeoutMs }),
    readPackageVersion(definition),
    readRelease(definition, repositories, releaseState),
  ]);
  // 代表値の正本は **Revisor が持つ版ファイル**。 次がリリースタグで、 `package.json` は
  // 最後の手段にとどめる — package.json を持たないサービス (Unity / Rust など) があり、
  // 版を持つ前提を敷けないため、 正本にはできない。 それでも欄としては返し続ける
  // (追従だけはする): ディスクとのズレは反映漏れの証拠になる。
  //
  // 版ファイルをタグより先に見るのは、 タグが「最後に公開した版」なのに対し、 版ファイルは
  // 「いまこのリポジトリが名乗る版」だから。 Concordia を 2.4.335 に初期化した直後に
  // タグ優先のままだと 2.4.0 と答えてしまい、 初期化した値がどこにも出なかった。
  const released = release.version ?? withoutTagPrefix(release.latestReleaseTag);
  return {
    service: definition.code,
    name: definition.name,
    repository: release.repository,
    cwd: definition.cwd,
    port: definition.port,
    version: released ?? running.version ?? packageVersion,
    running,
    packageVersion,
    releaseVersion: release.version,
    releaseStatus: release.status,
    latestReleaseTag: release.latestReleaseTag,
    unreleasedCommits: release.unreleasedCommits,
    drift: driftKinds({
      released,
      runningVersion: running.version,
      packageVersion,
      unreleasedCommits: release.unreleasedCommits,
    }),
  };
}

/**
 * @param {string[]} selectors 1 件以上のサービス名 (Excubitor code / リポジトリ / プロジェクトコード)。
 * @returns {Promise<{ requested: string, found: boolean, services: object[] }[]>}
 *   要求 1 件につき 1 要素。 解決できなかった要求も `found: false` で残す — 黙って
 *   落とすと「聞いたサービスが答えに無い」ことに呼び出し側が気付けない。
 */
/** @implements SPEC-SERVICE-VERSION-SOURCES */
export async function collectServiceVersions(selectors, {
  cwd = process.cwd(),
  repositories = [],
  releaseState = null,
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
        describeService(definition, { repositories, releaseState, fetchImpl, timeoutMs }))),
    };
  }));
}

/** CLI / 通知向けの 1 行表示。 */
export function formatServiceVersionLine(service) {
  const running = service.running.reachable
    ? `running ${service.running.version ?? "(unreported)"}`
    : "not running";
  const unreleased = Number.isInteger(service.unreleasedCommits) && service.unreleasedCommits > 0
    ? `, ${service.unreleasedCommits} unreleased commit(s)`
    : "";
  return `${service.service}: ${service.version ?? "unknown"} (${running}`
    + `, package ${service.packageVersion ?? "-"}`
    + `, tag ${service.latestReleaseTag ?? "-"}`
    + `, version file ${service.releaseVersion ?? "-"}${unreleased})`;
}
