/**
 * リリースする版に `package.json` を追従させる。
 *
 * 版の正本は Revisor が持つ版ファイル (`.revisor-version`) で、 `package.json` は正本に
 * しない — `package.json` を持たないサービス (Unity / Rust など) があり、 版を持つ前提を
 * 敷けないため。 それでも置き去りにすると、 走っているプロセスが `package.json` 由来の
 * 版を名乗る構成 (Excubitor が注入する) で、 公開済みの版と食い違ったままになる。
 * 実際に Concordia は v2.4.0 公開済みで `package.json` が 0.1.0 のままだった。
 *
 * **書き換えは公開の直前だけ**に置く。 公開はここで作った commit を含む base を
 * tag と一緒に atomic に push するので、 作業ツリーは汚れず origin とも一致する。
 * `version set` のようなローカル操作で commit すると、 push されない commit が base に
 * 積まれて merge パイプラインの分岐検出 (base-divergence) を誤爆させる。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./workspace.mjs";

const MANIFEST = "package.json";

function manifestPath(rootPath) {
  return join(rootPath, MANIFEST);
}

async function isTracked(rootPath, runGit) {
  const tracked = await runGit(rootPath, ["ls-files", "--", MANIFEST]);
  return tracked === MANIFEST;
}

/**
 * `version` フィールドだけを置き換える。 `JSON.parse` → `JSON.stringify` で書き戻すと
 * 整形・キー順・末尾改行が丸ごと変わり、 1 語の追従が全面書き換えの diff になる。
 */
function replaceVersion(source, from, to) {
  const needle = `"version": ${JSON.stringify(from)}`;
  const at = source.indexOf(needle);
  if (at === -1) return null;
  return source.slice(0, at) + `"version": ${JSON.stringify(to)}` + source.slice(at + needle.length);
}

/**
 * @param {{ rootPath: string, version: string, runGit?: typeof git }} input
 * @returns {Promise<{ synced: boolean, from?: string, to?: string, reason?: string }>}
 *   追従できない事情は失敗ではなく理由として返す。 `package.json` の都合で公開そのものを
 *   落とさない — 版の正本は版ファイル側にあり、 公開は既に成立しうる。
 */
export async function syncPackageVersion({ rootPath, version, runGit = git }) {
  let source;
  try {
    source = await readFile(manifestPath(rootPath), "utf8");
  } catch {
    return { synced: false, reason: "no package.json" };
  }
  if (!await isTracked(rootPath, runGit)) {
    return { synced: false, reason: "package.json is not tracked" };
  }
  let current;
  try {
    current = JSON.parse(source)?.version;
  } catch {
    return { synced: false, reason: "package.json is not valid JSON" };
  }
  if (typeof current !== "string" || current === "") {
    return { synced: false, reason: "package.json declares no version" };
  }
  if (current === version) return { synced: false, from: current, reason: "already current" };
  const updated = replaceVersion(source, current, version);
  if (updated === null) {
    return { synced: false, reason: "the version field could not be located" };
  }
  // 他の未コミット変更を巻き込まないよう、 対象を `package.json` 1 本に絞って commit する。
  await writeFile(manifestPath(rootPath), updated, "utf8");
  await runGit(rootPath, [
    "-c",
    "user.name=LUDIARS Revisor",
    "-c",
    "user.email=revisor@localhost",
    "commit",
    "--no-verify",
    "--only",
    "-m",
    `chore(release): follow Revisor version ${version}`,
    "--",
    MANIFEST,
  ]);
  return { synced: true, from: current, to: version };
}
