import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUiRequestHandler } from "../src/ui-server.mjs";
import { resolveOwnVersion } from "../src/own-version.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function request() {
  return {
    method: "GET",
    url: "/health",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1" },
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

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-ui-server-health-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

// AIFormat RULE_SRE.md §2。 version を名乗らないと Excubitor も Revisor 自身も
// 「走っている版」 を突き合わせられず、 反映したつもりを検出できない。
test("names itself and the version it is running", async () => {
  const state = fixture();
  const output = response();
  try {
    const handler = createUiRequestHandler({
      env: { ...state.env, EXCUBITOR_SERVICE_VERSION: "9.9.9" },
      sessionToken: "ui-session-token",
      queue: { state: () => ({}) },
      localPrService: {},
    });
    await handler(request(), output);
    assert.equal(output.status, 200);
    const body = JSON.parse(output.body);
    assert.equal(body.ok, true);
    assert.equal(body.service, "revisor");
    assert.equal(body.version, "9.9.9");
    // 既存の消費者が読んでいる形は残す。
    assert.equal(body.status, "ok");
    assert.equal(typeof body.configured, "boolean");
  } finally {
    removeFixture(state.directory);
  }
});

// Excubitor が注入しない直接起動 (`node src/cli.mjs serve`) でも版は名乗る。
test("falls back to the version on disk without an injected version", () => {
  assert.match(resolveOwnVersion({}), /^\d+\.\d+\.\d+/);
});
