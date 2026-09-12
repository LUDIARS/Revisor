import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RevisorError } from "../src/errors.mjs";
import {
  collectServiceVersions,
  formatServiceVersionLine,
  parseServiceSelectors,
} from "../src/service-version.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

/**
 * catalog を持つ workspace を 1 つ作る。 `Excubitor/catalog/` の存在が workspace root の
 * 目印で、 サービス定義は各リポジトリ直下の断片から読む (本番と同じ経路)。
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "revisor-service-version-"));
  mkdirSync(join(root, "Excubitor", "catalog"), { recursive: true });
  mkdirSync(join(root, "Alpha"), { recursive: true });
  mkdirSync(join(root, "Beta"), { recursive: true });
  writeFileSync(join(root, "Alpha", "excubitor.catalog.yaml"), [
    "services:",
    "  - code: alpha",
    "    name: Alpha",
    "    port: 5001",
    "    repo: LUDIARS/Alpha",
    "    cwd: ${ARS_ROOT}/Alpha",
    "    health:",
    "      type: http",
    "      url: http://127.0.0.1:5001/health",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "Beta", "excubitor.catalog.yaml"), [
    "services:",
    "  - code: beta",
    "    name: Beta",
    "    port: 5002",
    "    repo: LUDIARS/Beta",
    "    cwd: ${ARS_ROOT}/Beta",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "Alpha", "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8");
  writeFileSync(join(root, "Beta", "package.json"), JSON.stringify({ version: "4.5.6" }), "utf8");
  return root;
}

function healthResponder(versionByUrl) {
  return async (url) => {
    const version = versionByUrl[url];
    if (version === undefined) throw new Error("connect ECONNREFUSED");
    return { ok: true, async json() { return { ok: true, version }; } };
  };
}

test("requires at least one service", () => {
  assert.throws(() => parseServiceSelectors([]), RevisorError);
  assert.throws(() => parseServiceSelectors([""]), RevisorError);
  assert.throws(() => parseServiceSelectors(undefined), RevisorError);
});

test("accepts repeated and comma-joined selectors without duplicating them", () => {
  assert.deepEqual(parseServiceSelectors(["alpha", "beta,alpha", " gamma "]), [
    "alpha",
    "beta",
    "gamma",
  ]);
});

test("reports the running version alongside the version on disk", async () => {
  const root = workspace();
  try {
    const [alpha] = await collectServiceVersions(["alpha"], {
      cwd: root,
      fetchImpl: healthResponder({ "http://127.0.0.1:5001/health": "1.2.2" }),
    });
    assert.equal(alpha.found, true);
    const [service] = alpha.services;
    assert.equal(service.running.reachable, true);
    assert.equal(service.running.version, "1.2.2");
    assert.equal(service.packageVersion, "1.2.3");
    // 走っている版を代表値に採る。 ディスクとのズレ自体が知りたい情報なので、
    // 両方残したまま表示用の 1 つだけを決める。
    assert.equal(service.version, "1.2.2");
  } finally {
    removeFixture(root);
  }
});

test("falls back to the version on disk when the service is not running", async () => {
  const root = workspace();
  try {
    const [alpha] = await collectServiceVersions(["alpha"], {
      cwd: root,
      fetchImpl: healthResponder({}),
    });
    const [service] = alpha.services;
    assert.equal(service.running.reachable, false);
    assert.match(service.running.error, /ECONNREFUSED/);
    assert.equal(service.version, "1.2.3");
  } finally {
    removeFixture(root);
  }
});

test("says so when the catalog declares no health endpoint", async () => {
  const root = workspace();
  try {
    const [beta] = await collectServiceVersions(["beta"], { cwd: root, fetchImpl: healthResponder({}) });
    const [service] = beta.services;
    assert.equal(service.running.reachable, false);
    assert.match(service.running.error, /No health endpoint/);
    assert.equal(service.version, "4.5.6");
  } finally {
    removeFixture(root);
  }
});

// 解決できなかった要求を黙って落とすと、 聞いたサービスが答えに無いことに
// 呼び出し側が気付けない。
test("keeps an unresolvable request in the answer", async () => {
  const root = workspace();
  try {
    const results = await collectServiceVersions(["alpha", "nope"], {
      cwd: root,
      fetchImpl: healthResponder({}),
    });
    assert.deepEqual(results.map((result) => [result.requested, result.found]), [
      ["alpha", true],
      ["nope", false],
    ]);
    assert.deepEqual(results[1].services, []);
  } finally {
    removeFixture(root);
  }
});

test("renders one line per service", async () => {
  const root = workspace();
  try {
    const [alpha] = await collectServiceVersions(["alpha"], {
      cwd: root,
      fetchImpl: healthResponder({ "http://127.0.0.1:5001/health": "1.2.2" }),
    });
    assert.equal(
      formatServiceVersionLine(alpha.services[0]),
      "alpha: 1.2.2 (running 1.2.2, package 1.2.3, release -)",
    );
  } finally {
    removeFixture(root);
  }
});
