import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAllowedHosts, writeWorkflowToken } from "../src/config.mjs";
import { createRequestHandler } from "../src/server.mjs";

function request({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:4240", ...headers },
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

test("authenticates and creates a local PR without a GitHub head", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  let submitted;
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {
      async submitPullRequest(value) {
        submitted = value;
        return { id: "pr-1", number: 1, checkStatus: "queued" };
      },
    },
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer workflow-token" },
      body: JSON.stringify({
        repository: "LUDIARS/Revisor",
        title: "Local workflow",
        body: "Never push the head branch.",
        author: "neco",
        head_ref: "feat/local-workflow",
      }),
    }), output);
    assert.equal(output.status, 202);
    assert.equal(submitted.repository, "LUDIARS/Revisor");
    assert.equal(submitted.headRef, "feat/local-workflow");
    assert.equal("headSha" in submitted, false);
    assert.deepEqual(JSON.parse(output.body).pullRequest, {
      id: "pr-1",
      number: 1,
      checkStatus: "queued",
    });
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects unauthenticated local workflow requests", async () => {
  const state = fixture();
  writeWorkflowToken("workflow-token", state.env);
  const handler = createRequestHandler({
    env: state.env,
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
  });
  const output = response();
  try {
    await handler(request({
      method: "POST",
      url: "/v1/local-prs",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    }), output);
    assert.equal(output.status, 401);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects non-loopback clients before reading credentials", async () => {
  const handler = createRequestHandler({
    env: {},
    sessionToken: "ui-token",
    queue: { state: () => ({}) },
    localPrService: {},
  });
  const output = response();
  const input = request({ method: "GET", url: "/v1/local-prs" });
  input.socket.remoteAddress = "203.0.113.7";
  await handler(input, output);
  assert.equal(output.status, 403);
});

test("serves the UI through an encrypted configured host", async () => {
  const state = fixture();
  try {
    writeAllowedHosts(["revisor.example.com"], state.env);
    const handler = createRequestHandler({
      env: state.env,
      sessionToken: "ui-token",
      queue: { state: () => ({}) },
      localPrService: {},
    });
    const allowed = response();
    await handler(request({
      method: "GET",
      url: "/",
      headers: { host: "revisor.example.com" },
    }), allowed);
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /<h1>Revisor<\/h1>/);

    const rejected = response();
    await handler(request({
      method: "GET",
      url: "/",
      headers: { host: "other.example.com" },
    }), rejected);
    assert.equal(rejected.status, 403);
    assert.match(JSON.parse(rejected.body).error, /Host is not allowed/);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
