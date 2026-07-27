import assert from "node:assert/strict";
import test from "node:test";
import { renderSettingsPage } from "../src/ui-page.mjs";
import { isAuthorizedSession, isLoopbackHost } from "../src/ui-security.mjs";

test("renders a dedicated token-free settings page", () => {
  const page = renderSettingsPage("session-nonce");
  assert.match(page, /<h1>Revisor<\/h1>/);
  assert.match(page, /Anatomiaフォルダ/);
  assert.match(page, /並列ワーカープロセス数/);
  assert.match(page, /GitHub App ID/);
  assert.match(page, /nonce="session-nonce"/);
  assert.doesNotMatch(page, /origin-secret/);
});

test("limits settings access to loopback and the UI session", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4240"), true);
  assert.equal(isLoopbackHost("localhost:4240"), true);
  assert.equal(isLoopbackHost("review.example.com"), false);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "a" }, "a"), true);
  assert.equal(isAuthorizedSession({ "x-revisor-session": "b" }, "a"), false);
});
