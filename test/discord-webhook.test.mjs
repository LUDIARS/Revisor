import assert from "node:assert/strict";
import test from "node:test";
import {
  isDiscordWebhookUrl,
  postDiscordWebhook,
  truncateContent,
} from "../src/discord-webhook.mjs";

const webhookUrl = "https://discord.com/api/webhooks/123456/abc";

test("accepts only Discord webhook endpoints", () => {
  assert.equal(isDiscordWebhookUrl(webhookUrl), true);
  assert.equal(isDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456/abc"), true);
  for (const value of [
    "http://discord.com/api/webhooks/123456/token",
    "https://example.com/api/webhooks/123456/token",
    "https://discord.com/api/channels/123456/token",
  ]) {
    assert.equal(isDiscordWebhookUrl(value), false);
  }
});

test("truncates Discord content at 2000 characters", () => {
  assert.equal(truncateContent("x".repeat(2000)), "x".repeat(2000));
  const value = truncateContent("x".repeat(2001));
  assert.equal(value.length, 2000);
  assert.match(value, /… \(省略\)$/);
});

test("posts a safe, truncated Discord webhook message", async () => {
  let request;
  const sent = await postDiscordWebhook({
    url: webhookUrl,
    text: "x".repeat(2001),
    username: "Review Bot",
    transport: async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
  });
  assert.equal(sent, true);
  assert.equal(request.url, webhookUrl);
  const body = JSON.parse(request.options.body);
  assert.equal(body.content.length, 2000);
  assert.equal(body.username, "Review Bot");
  assert.deepEqual(body.allowed_mentions, { parse: [] });
});

test("does not fail lifecycle work when webhook delivery fails", async () => {
  assert.equal(await postDiscordWebhook({
    url: webhookUrl,
    text: "notice",
    transport: async () => ({ ok: false }),
  }), false);
  assert.equal(await postDiscordWebhook({
    url: webhookUrl,
    text: "notice",
    transport: async () => { throw new Error("offline"); },
  }), false);
  let called = false;
  assert.equal(await postDiscordWebhook({
    url: "https://example.com/webhook",
    text: "notice",
    transport: async () => { called = true; },
  }), false);
  assert.equal(await postDiscordWebhook({
    url: webhookUrl,
    text: "",
    transport: async () => { called = true; },
  }), false);
  assert.equal(called, false);
});
