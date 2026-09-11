import assert from "node:assert/strict";
import test from "node:test";
import { isSlackWebhookUrl, postSlackWebhook } from "../src/slack-webhook.mjs";

test("posts sanitized text to a Slack incoming webhook", async () => {
  let request;
  const url = "https://hooks.slack.com/services/T000/B000/secret";
  assert.equal(isSlackWebhookUrl(url), true);
  assert.equal(await postSlackWebhook({
    url,
    text: "release <!channel> <!here> <@U123>",
    transport: async (_url, value) => {
      request = value;
      return { ok: true };
    },
  }), true);
  const body = JSON.parse(request.body);
  assert.doesNotMatch(body.text, /<!channel>|<!here>|<@U123>/);
  assert.equal(request.signal.aborted, false);
});

test("rejects non-Slack URLs without transport", async () => {
  let called = false;
  assert.equal(await postSlackWebhook({
    url: "https://example.test/hook",
    text: "notice",
    transport: async () => { called = true; },
  }), false);
  assert.equal(called, false);
});
