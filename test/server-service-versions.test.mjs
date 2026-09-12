import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequestHandler } from "../src/server.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function request(url) {
  return {
    method: "GET",
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:4240" },
    async *[Symbol.asyncIterator]() {},
  };
}

function response() {
  return {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "revisor-service-versions-api-"));
  mkdirSync(join(root, "Excubitor", "catalog"), { recursive: true });
  mkdirSync(join(root, "Alpha"), { recursive: true });
  writeFileSync(join(root, "Alpha", "excubitor.catalog.yaml"), [
    "services:",
    "  - code: alpha",
    "    name: Alpha",
    "    port: 5001",
    "    repo: LUDIARS/Alpha",
    "    cwd: ${ARS_ROOT}/Alpha",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "Alpha", "package.json"), JSON.stringify({ version: "1.2.3" }), "utf8");
  return root;
}

function handlerFor(cwd) {
  return createRequestHandler({
    env: {},
    cwd,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: { store: { listRepositories: () => [] } },
  });
}

test("answers the versions of the named services", async () => {
  const root = workspace();
  const output = response();
  try {
    await handlerFor(root)(request("/v1/service-versions?service=alpha"), output);
    assert.equal(output.status, 200);
    const [result] = JSON.parse(output.body).versions;
    assert.equal(result.requested, "alpha");
    assert.equal(result.found, true);
    assert.equal(result.services[0].packageVersion, "1.2.3");
  } finally {
    removeFixture(root);
  }
});

// 既定で 93 サービス分の health を叩く呼び出しが打ち間違いから生まれないよう、
// サービスを 1 つも名指ししない要求は受け付けない。
test("rejects a request that names no service", async () => {
  const root = workspace();
  const output = response();
  try {
    await handlerFor(root)(request("/v1/service-versions"), output);
    assert.equal(output.status, 400);
    assert.match(JSON.parse(output.body).error, /At least one service/);
  } finally {
    removeFixture(root);
  }
});

test("accepts several services in one request", async () => {
  const root = workspace();
  const output = response();
  try {
    await handlerFor(root)(
      request("/v1/service-versions?service=alpha&service=nope"),
      output,
    );
    assert.equal(output.status, 200);
    assert.deepEqual(
      JSON.parse(output.body).versions.map((result) => [result.requested, result.found]),
      [["alpha", true], ["nope", false]],
    );
  } finally {
    removeFixture(root);
  }
});
