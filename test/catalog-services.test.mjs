import assert from "node:assert/strict";
import test from "node:test";
import {
  findServiceDefinitions,
  parseServiceDefinitions,
} from "../src/catalog-services.mjs";

const CATALOG = [
  "services:",
  "  - code: revisor",
  "    name: Revisor (PR Review)",
  "    project_code: revisor",
  "    port: 4240",
  "    repo: LUDIARS/Revisor",
  "    cwd: ${ARS_ROOT}/Revisor",
  "    health:",
  "      type: http",
  "      url: http://127.0.0.1:4240/health",
  "      interval_sec: 30",
  "  - code: concordia",
  "    name: Concordia",
  "    project_code: concordia",
  "    port: 11111",
  "    repo: LUDIARS/Concordia",
  "    cwd: ${ARS_ROOT}/Concordia",
  "    health:",
  "      type: http",
  "      url: http://localhost:11111/health",
  "  - code: concordia-cost",
  "    name: Concordia cost worker",
  "    project_code: concordia",
  "    repo: LUDIARS/Concordia",
  "    cwd: ${ARS_ROOT}/Concordia",
  "  - code: excubitor-viewer-dmz",
  "    name: Excubitor viewer",
  "    project_code: Ex",
  "    port: 17334",
  "    repo: LUDIARS/Excubitor",
  "",
].join("\n");

test("reads every scalar a version answer needs from a service block", () => {
  const [revisor] = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  assert.deepEqual(revisor, {
    code: "revisor",
    name: "Revisor (PR Review)",
    port: 4240,
    cwd: "E:/Document/Ars/Revisor",
    repo: "LUDIARS/Revisor",
    projectCode: "revisor",
    healthUrl: "http://127.0.0.1:4240/health",
  });
});

// catalog は Windows の checkout では CRLF で置かれる。 行末の復帰文字が残ると
// `health:` の入れ子だけが静かに読めなくなり、 生きているサービスが「停止中」に見える。
test("reads the nested health block from a CRLF catalog", () => {
  const definitions = parseServiceDefinitions(CATALOG.replaceAll("\n", "\r\n"), "E:/Document/Ars");
  assert.equal(definitions[0].healthUrl, "http://127.0.0.1:4240/health");
  assert.equal(definitions[0].cwd, "E:/Document/Ars/Revisor");
});

// Windows の `localhost` は ::1 を先に返す一方、 サービスは 127.0.0.1 にだけ bind する。
test("rewrites a localhost health URL to the loopback address", () => {
  const definitions = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  const concordia = definitions.find((definition) => definition.code === "concordia");
  assert.equal(concordia.healthUrl, "http://127.0.0.1:11111/health");
});

test("resolves an exact service code to that one service", () => {
  const definitions = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  assert.deepEqual(
    findServiceDefinitions(definitions, "concordia").map((entry) => entry.code),
    ["concordia"],
  );
});

// リポジトリ名を code と同列に見ると catalog の並び順しだいで別サービスに着地する。
test("prefers the service code over another service sharing the repository", () => {
  const definitions = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  assert.deepEqual(
    findServiceDefinitions(definitions, "revisor").map((entry) => entry.code),
    ["revisor"],
  );
});

test("resolves a repository to every service it runs", () => {
  const definitions = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  assert.deepEqual(
    findServiceDefinitions(definitions, "LUDIARS/Concordia").map((entry) => entry.code),
    ["concordia", "concordia-cost"],
  );
});

test("resolves a project code and a repository name case-insensitively", () => {
  const definitions = parseServiceDefinitions(CATALOG, "E:/Document/Ars");
  assert.deepEqual(
    findServiceDefinitions(definitions, "ex").map((entry) => entry.code),
    ["excubitor-viewer-dmz"],
  );
  assert.deepEqual(
    findServiceDefinitions(definitions, "Excubitor").map((entry) => entry.code),
    ["excubitor-viewer-dmz"],
  );
});

test("reports no match instead of guessing", () => {
  assert.deepEqual(findServiceDefinitions(parseServiceDefinitions(CATALOG), "nope"), []);
  assert.deepEqual(findServiceDefinitions(parseServiceDefinitions(CATALOG), "  "), []);
});
