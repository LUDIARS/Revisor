/**
 * Revisor 自身が名乗る版。
 *
 * AIFormat `RULE_SRE.md` §2 は `/health` に `ok` / `service` / `version` を求める。
 * version は**ディスクに何が置かれているか**ではなく**このプロセスが何を読み込んで
 * 走っているか**なので、 Excubitor が起動時に注入した値を最優先で採る。 注入が無い
 * 直接起動 (`node src/cli.mjs serve`) のためにディスクの package.json へ落ちる。
 *
 * これが無いと Revisor は版を名乗らないサービスになり、 Revisor 自身が提供する
 * サービス版一覧 (`service-version.mjs`) で自分だけ `(unreported)` になる。
 */

import { readFileSync } from "node:fs";

const UNKNOWN_VERSION = "0.0.0+unversioned";

function fromEnv(env) {
  for (const key of ["EXCUBITOR_SERVICE_VERSION", "REVISOR_SERVICE_VERSION", "npm_package_version"]) {
    const value = String(env?.[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

function fromManifest() {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const version = String(manifest?.version ?? "").trim();
    return version || null;
  } catch {
    return null;
  }
}

/** @returns {string} 常に文字列。 解決できなければ `0.0.0+unversioned`。 */
export function resolveOwnVersion(env = process.env) {
  return fromEnv(env) ?? fromManifest() ?? UNKNOWN_VERSION;
}
