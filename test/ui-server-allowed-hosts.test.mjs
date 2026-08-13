import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasWorkflowToken, readAllowedHosts, readSettings } from "../src/config.mjs";
import { createUiRequestHandler } from "../src/ui-server.mjs";

function request({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1", ...headers },
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
  const directory = mkdtempSync(join(tmpdir(), "revisor-ui-server-allowed-hosts-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

function handler(env, sessionToken = "ui-session-token") {
  return createUiRequestHandler({
    env,
    sessionToken,
    queue: { state: () => ({}) },
    localPrService: {},
  });
}

test("saves allowed hosts before initial setup and applies them immediately", async () => {
  const state = fixture();
  try {
    const handle = handler(state.env);
    assert.equal(readSettings(state.env).anatomiaFolder, "");
    assert.equal(hasWorkflowToken(state.env), false);

    const save = response();
    await handle(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: ["revisor.example.com"] }),
    }), save);
    assert.equal(save.status, 200);
    assert.deepEqual(JSON.parse(save.body).allowedHosts, ["revisor.example.com"]);
    assert.deepEqual(readAllowedHosts(state.env), ["revisor.example.com"]);
    assert.equal(readSettings(state.env).anatomiaFolder, "");

    const probe = response();
    await handle(request({
      method: "GET",
      url: "/health",
      headers: { host: "revisor.example.com" },
    }), probe);
    assert.equal(probe.status, 200);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("rejects an invalid host without dropping the hosts already in effect", async () => {
  const state = fixture();
  try {
    const handle = handler(state.env);
    const save = response();
    await handle(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: ["revisor.example.com"] }),
    }), save);
    assert.equal(save.status, 200);

    const rejected = response();
    await handle(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: ["https://revisor.example.com/path"] }),
    }), rejected);
    assert.equal(rejected.status, 400);
    assert.deepEqual(readAllowedHosts(state.env), ["revisor.example.com"]);

    const probe = response();
    await handle(request({
      method: "GET",
      url: "/health",
      headers: { host: "revisor.example.com" },
    }), probe);
    assert.equal(probe.status, 200);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

// An empty array is the only way to withdraw a host that must stop reaching the
// process, so it has to clear both the stored config and the list in effect.
test("an empty list withdraws every registered host in the same process", async () => {
  const state = fixture();
  try {
    const handle = handler(state.env);
    const save = response();
    await handle(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: ["revisor.example.com"] }),
    }), save);
    assert.equal(save.status, 200);

    const cleared = response();
    await handle(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: [] }),
    }), cleared);
    assert.equal(cleared.status, 200);
    assert.deepEqual(JSON.parse(cleared.body).allowedHosts, []);
    assert.deepEqual(readAllowedHosts(state.env), []);

    const probe = response();
    await handle(request({
      method: "GET",
      url: "/health",
      headers: { host: "revisor.example.com" },
    }), probe);
    assert.equal(probe.status, 403);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("requires an authorized UI session for the independent endpoint", async () => {
  const state = fixture();
  try {
    const rejected = response();
    await handler(state.env)(request({
      method: "PUT",
      url: "/api/settings/allowed-hosts",
      headers: { "x-revisor-session": "wrong" },
      body: JSON.stringify({ allowedHosts: ["revisor.example.com"] }),
    }), rejected);
    assert.equal(rejected.status, 403);
    assert.deepEqual(readAllowedHosts(state.env), []);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("the general settings endpoint cannot update allowed hosts", async () => {
  const state = fixture();
  try {
    const rejected = response();
    await handler(state.env)(request({
      method: "PUT",
      url: "/api/settings",
      headers: { "x-revisor-session": "ui-session-token" },
      body: JSON.stringify({ allowedHosts: ["revisor.example.com"] }),
    }), rejected);
    assert.equal(rejected.status, 400);
    assert.match(JSON.parse(rejected.body).error, /\/api\/settings\/allowed-hosts/);
    assert.deepEqual(readAllowedHosts(state.env), []);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("filters and summarizes session-authorized local PR lists", async () => {
  const state = fixture();
  try {
    const pullRequests = [{
      id: "pr-open", number: 1, repository: "LUDIARS/Revisor", title: "Open PR",
      status: "open", checkStatus: "queued", createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:01:00.000Z", decision: { state: "needs_human" }, body: "full",
    }];
    const handle = createUiRequestHandler({
      env: state.env, sessionToken: "ui-session-token", queue: { state: () => ({}) },
      localPrService: { listPullRequests: () => pullRequests },
    });
    const full = response();
    await handle(request({
      url: "/api/local-prs",
      headers: { "x-revisor-session": "ui-session-token" },
    }), full);
    assert.equal(full.status, 200);
    assert.equal(full.body, JSON.stringify({ pullRequests }));

    const summary = response();
    await handle(request({
      url: "/api/local-prs?view=summary&state=open",
      headers: { "x-revisor-session": "ui-session-token" },
    }), summary);
    assert.equal(summary.status, 200);
    assert.equal("body" in JSON.parse(summary.body).pullRequests[0], false);

    const invalid = response();
    await handle(request({
      url: "/api/local-prs?state=invalid",
      headers: { "x-revisor-session": "ui-session-token" },
    }), invalid);
    assert.equal(invalid.status, 400);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
