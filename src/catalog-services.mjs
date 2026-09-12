/**
 * Excubitor catalog から **サービス定義** を取り出す。
 *
 * `catalog.mjs` は「ポート 1 個を引く」ことに特化していて、 サービスの版を答えるには
 * 足りない — 版は health endpoint (走っているプロセスが名乗る版) と catalog の `cwd`
 * (ディスクに置かれている版) の両方から取るので、 code / port / cwd / health url を
 * まとめて持つ定義が要る。 catalog の読み取り規約 (中央 services.yaml + 各リポの
 * 断片、 後者が private サービスを持つ) は `catalog.mjs` と同じものをここでも使う。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findExcubitorCatalog, findWorkspaceRoot } from "./catalog.mjs";
import { RevisorError } from "./errors.mjs";

/** サービスブロックの開始行。 中央カタログと断片で同じ形。 */
const BLOCK_BOUNDARY = /(?=^ {2}- code:)/m;

function scalar(block, key, { indent = 4 } = {}) {
  const pattern = new RegExp(`^ {${indent}}${key}:[ \\t]*(.+?)[ \\t]*$`, "m");
  const value = pattern.exec(block)?.[1];
  if (value === undefined) return null;
  const unquoted = value.replace(/^["']|["']$/g, "").trim();
  return unquoted === "" ? null : unquoted;
}

/**
 * `${ARS_ROOT}` は Excubitor が子プロセスへ注入する展開前の形のまま catalog に載る。
 * 版を読むにはディスク上の実パスが要るので、 workspace root で解決する。
 */
function expandRoot(value, workspaceRoot) {
  if (value === null) return null;
  return value.replaceAll("${ARS_ROOT}", workspaceRoot.replaceAll("\\", "/"));
}

function port(block) {
  const raw = scalar(block, "port");
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/**
 * catalog には `http://localhost:<port>/...` と書かれた health URL がある。 Windows の
 * `localhost` は `::1` を先に返す一方、 LUDIARS のサービスは 127.0.0.1 にだけ bind する
 * ので、 そのまま叩くと生きているサービスが `ECONNREFUSED` で「停止中」に見える
 * (Concordia で実際に起きた)。 catalog を読んだ時点で loopback へ寄せる。
 */
function loopbackHost(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** health は入れ子なので 1 段深い indent で読む。 */
function healthUrl(block) {
  const health = /^ {4}health:\n((?: {6}.*\n?)*)/m.exec(block)?.[1];
  const url = health ? scalar(health, "url", { indent: 6 }) : null;
  return url ? loopbackHost(url) : null;
}

/**
 * catalog は CRLF で置かれていることがある (Windows の checkout)。 行末の復帰文字が
 * 残ると `health:` の入れ子ブロックのように「行単位で切り出す」読み取りが静かに
 * 空振りするので、 解析の入口で 1 度だけ正規化する。
 *
 * @param {string} catalogText
 * @returns {ServiceDefinition[]}
 */
export function parseServiceDefinitions(catalogText, workspaceRoot = "") {
  return String(catalogText).replace(/\r\n?/g, "\n").split(BLOCK_BOUNDARY)
    .filter((block) => /^ {2}- code:/.test(block))
    .map((block) => ({
      code: scalar(block, "- code", { indent: 2 }),
      name: scalar(block, "name"),
      port: port(block),
      cwd: expandRoot(scalar(block, "cwd"), workspaceRoot),
      repo: scalar(block, "repo"),
      projectCode: scalar(block, "project_code"),
      healthUrl: healthUrl(block),
    }))
    .filter((definition) => definition.code !== null);
}

/**
 * 中央カタログと全断片を 1 つの表にする。 同じ code が両方にあれば中央を優先する
 * (断片は「中央に載せられない定義」を補う側であって、 上書きする側ではない)。
 */
export function listServiceDefinitions(cwd = process.cwd()) {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const byCode = new Map();
  const central = findExcubitorCatalog(cwd);
  const sources = [
    ...(central ? [central] : []),
    ...readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceRoot, entry.name, "excubitor.catalog.yaml"))
      .filter((path) => existsSync(path)),
  ];
  for (const source of sources) {
    let definitions;
    try {
      definitions = parseServiceDefinitions(readFileSync(source, "utf8"), workspaceRoot);
    } catch {
      continue; // 読めない断片 1 枚で全サービスの解決を落とさない。
    }
    for (const definition of definitions) {
      if (!byCode.has(definition.code)) byCode.set(definition.code, definition);
    }
  }
  return [...byCode.values()];
}

function lower(value) {
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

/**
 * 別名は「強い順」に段を分ける。 1 つのリポジトリが複数サービスを持つのは普通で
 * (Excubitor は `excubitor` と `excubitor-viewer-dmz`)、 リポジトリ名を code と同列に
 * 見ると catalog の並び順しだいで別サービスに着地する。 実際 `excubitor` が
 * `excubitor-viewer-dmz` に解決された。
 */
const ALIAS_TIERS = [
  (definition) => [lower(definition.code)],
  (definition) => [lower(definition.projectCode)],
  (definition) => [
    lower(definition.repo),
    lower(definition.repo?.split("/").pop()),
    lower(definition.cwd ? basename(definition.cwd.replace(/[\\/]+$/, "")) : null),
  ],
];

/**
 * 呼び出し側 (Concordia / CLI) が持っている名前はまちまち — Excubitor の code、
 * リポジトリ名、 プロジェクトコードのどれで来ても同じサービスに着地させる。
 *
 * code で名指しされたら 1 件に絞る。 リポジトリ / プロジェクトで呼ばれたら、 そこに
 * 属する**全サービス**を返す — 1 リポジトリが複数サービスを持つ構成 (Concordia は
 * `concordia` / `concordia-control` / `concordia-cost`) で「Concordia の版」を聞かれて
 * 1 つだけ答えると、 残りが古いまま走っていても見えないため。
 *
 * @returns {ServiceDefinition[]}
 */
export function findServiceDefinitions(definitions, identifier) {
  const needle = lower(String(identifier ?? "").trim());
  if (!needle) return [];
  for (const aliases of ALIAS_TIERS) {
    const matches = definitions.filter((definition) => aliases(definition).includes(needle));
    if (matches.length > 0) return matches;
  }
  return [];
}

export function resolveServiceDefinitions(cwd, identifier) {
  const matches = findServiceDefinitions(listServiceDefinitions(cwd), identifier);
  if (matches.length === 0) {
    throw new RevisorError(`Service '${identifier}' is not registered in Excubitor.`);
  }
  return matches;
}
