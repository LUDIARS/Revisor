import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeOriginToken } from "../src/config.mjs";
import { createRequestHandler } from "../src/server.mjs";

function request({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  return {
    method,
    url,
    headers: { host: "pr-gate.example.com", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, "utf8");
    },
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
  const directory = mkdtempSync(join(tmpdir(), "revisor-server-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

test("authenticates and enqueues an external PR request", async () => {
  const state = fixture();
  writeOriginToken("origin-token", state.env);
  let submitted;
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: {
      async submit(value) {
        submitted = value;
        return {
          id: "job-1",
          status: "queued",
          checkUrl: "https://github.com/LUDIARS/Revisor/runs/1",
        };
      },
      get: () => null,
    },
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/pr-gate/jobs",
      headers: { authorization: "Bearer origin-token" },
      body: JSON.stringify({
        repository: "LUDIARS/Revisor",
        number: 1,
        head_sha: "a".repeat(40),
        head_ref: "feat/review",
        head_repository: "LUDIARS/Revisor",
        base_ref: "main",
        review_mode: "verification",
      }),
    }), output);
    assert.equal(output.status, 202);
    assert.equal(submitted.repository, "LUDIARS/Revisor");
    assert.equal(submitted.reviewMode, "verification");
    assert.deepEqual(JSON.parse(output.body), {
      id: "job-1",
      status: "queued",
      check_url: "https://github.com/LUDIARS/Revisor/runs/1",
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects unauthenticated external requests", async () => {
  const state = fixture();
  writeOriginToken("origin-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { submit: () => null, get: () => null },
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/pr-gate/jobs",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    }), output);
    assert.equal(output.status, 401);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
