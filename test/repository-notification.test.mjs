import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverRepositoryNotifications,
  notifyRepositoryEvent,
} from "../src/repository-notification.mjs";

test("uses fixture transports and isolates a failed notification", async () => {
  const result = await deliverRepositoryNotifications({
    targets: ["discord:release", "slack:deploy", "unknown:nope"],
    text: "notice",
    readSecret: (name) => `https://fixture/${name}`,
    discord: async () => true,
    slack: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(result, [
    { target: "discord:release", sent: true },
    { target: "slack:deploy", sent: false },
  ]);
});

test("posts a structured release event to Concordia through a fixture transport", async () => {
  let request;
  const result = await notifyRepositoryEvent({
    repository: { repository: "LUDIARS/Product", notify: { release: ["concordia"] } },
    event: "release",
    text: "release notice",
    kind: "minor",
    tag: "v1.5.0",
    previousTag: "v1.4.8",
    version: "1.5.0",
    title: "Product 1.5",
    notice: "release notice",
    releaseUrl: "https://github.example/releases/v1.5.0",
    publishedAt: "2026-09-12T00:00:00.000Z",
    resolveConcordiaUrl: () => "http://127.0.0.1:11111/",
    transport: async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
  });
  assert.deepEqual(result, [{ target: "concordia", sent: true }]);
  assert.equal(request.url, "http://127.0.0.1:11111/v1/events/release-published");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.signal.aborted, false);
  assert.deepEqual(JSON.parse(request.options.body), {
    repository: "LUDIARS/Product",
    kind: "minor",
    tag: "v1.5.0",
    previousTag: "v1.4.8",
    version: "1.5.0",
    title: "Product 1.5",
    notice: "release notice",
    releaseUrl: "https://github.example/releases/v1.5.0",
    publishedAt: "2026-09-12T00:00:00.000Z",
  });
});

test("does not send Concordia targets for merged notifications", async () => {
  let called = false;
  const result = await notifyRepositoryEvent({
    repository: { repository: "LUDIARS/Product", notify: { merged: ["concordia", "discord:team"] } },
    event: "merged",
    text: "merged notice",
    readSecret: () => "https://fixture/webhook.team",
    discord: async () => true,
    resolveConcordiaUrl: () => {
      called = true;
      return "http://127.0.0.1:11111";
    },
  });
  assert.deepEqual(result, [{ target: "discord:team", sent: true }]);
  assert.equal(called, false);
});
